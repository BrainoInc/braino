import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { installPlugin } from "../plugin-installations.js";
import {
  connectWorkspaceTeamChatPlugin,
  resolveWorkspaceTeamChatPlugin,
} from "../plugin-team-chat.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "team-chat-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";

const manifest: PluginManifest = {
  protocolVersion: 2,
  id: "braino.slack",
  name: "Señor Braino for Slack",
  version: "0.1.0",
  capabilities: { "event.receive": 1, "team_chat.connect": 1, "team_chat.send": 1 },
  permissions: { network: ["slack.com"] },
  secretSchema: {
    type: "object",
    properties: {
      bot_token: { type: "string" },
      signing_secret: { type: "string" },
    },
    required: ["bot_token", "signing_secret"],
    additionalProperties: false,
  },
};

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const installation = await installPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    manifest,
    component: new TextEncoder().encode("slack component"),
    secrets: { bot_token: "xoxb-workspace", signing_secret: "signing-secret" },
    encryptionKey,
  });
  return { ...setup, installation };
}

describe("workspace team-chat plugin", () => {
  it("commits an installation only after live verification and keeps one provider enabled", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "verified",
      workspaceName: "Verified",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });
    const fetcher = vi.fn(async () =>
      Response.json({
        outputJson: JSON.stringify({
          externalWorkspaceId: "T1",
          workspaceName: "Acme Slack",
          botUserId: "U-BOT",
          channels: [{ id: "C1", name: "general" }],
        }),
      }),
    ) as typeof fetch;

    await expect(
      connectWorkspaceTeamChatPlugin(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        manifest,
        component: new TextEncoder().encode("slack component"),
        configuration: {},
        secrets: { bot_token: "xoxb", signing_secret: "secret" },
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
        connectionInput: { installer: { email: "owner@example.com" } },
        fetcher,
      }),
    ).resolves.toMatchObject({
      connection: { externalWorkspaceId: "T1", workspaceName: "Acme Slack" },
      installation: { workspaceId: setup.workspace.id },
    });

    const invalidFetcher = vi.fn(async () =>
      Response.json({ outputJson: JSON.stringify({ externalWorkspaceId: "" }) }),
    ) as typeof fetch;
    await expect(
      connectWorkspaceTeamChatPlugin(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        manifest: { ...manifest, id: "acme.teams", name: "Teams" },
        component: new TextEncoder().encode("teams component"),
        configuration: {},
        secrets: {},
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
        connectionInput: {},
        fetcher: invalidFetcher,
      }),
    ).rejects.toMatchObject({ code: "plugin_output_invalid" });

    const rows = await db.query<{ plugin_id: string; enabled: boolean }>(
      "SELECT manifest->>'id' AS plugin_id, enabled FROM plugin_installations ORDER BY plugin_id",
    );
    expect(rows.rows).toEqual([{ plugin_id: "braino.slack", enabled: true }]);
  });

  it("uses one workspace installation for connect, inbound events, and outbound messages", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      if (envelope.capability === "team_chat.connect") {
        return Response.json({
          outputJson: JSON.stringify({
            externalWorkspaceId: "T1",
            workspaceName: "Acme Slack",
            botUserId: "U-BOT",
            installerUserId: "U-OWNER",
            channels: [{ id: "C1", name: "general" }],
          }),
        });
      }
      if (envelope.capability === "event.receive") {
        return Response.json({
          outputJson: JSON.stringify([
            {
              id: "Ev1",
              occurredAt: "2026-11-16T04:00:00.000Z",
              kind: "team_chat.message",
              data: {
                channelId: "C1",
                senderId: "U1",
                senderEmail: "owner@example.com",
                text: "What changed?",
                messageId: "171.1",
                direct: false,
              },
            },
          ]),
        });
      }
      return Response.json({ outputJson: JSON.stringify({ externalId: "171.3" }) });
    }) as typeof fetch;
    const plugin = await resolveWorkspaceTeamChatPlugin(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher,
    });

    expect(plugin).not.toBeNull();
    await expect(
      plugin?.connect({
        installer: { email: "owner@example.com" },
        introductionChannel: "general",
      }),
    ).resolves.toMatchObject({ externalWorkspaceId: "T1", workspaceName: "Acme Slack" });
    await expect(
      plugin?.receive({
        body: "{}",
        headers: { "x-slack-signature": "v0=abc" },
        receivedAt: 123,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "Ev1", kind: "team_chat.message" })]);
    await expect(
      plugin?.send({ target: { kind: "channel", id: "C1" }, text: "Hello", threadId: "171.1" }),
    ).resolves.toEqual({ externalId: "171.3" });

    expect(fetcher).toHaveBeenCalledTimes(3);
    const envelopes = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(envelopes.map((value) => value.capability)).toEqual([
      "team_chat.connect",
      "event.receive",
      "team_chat.send",
    ]);
    expect(envelopes.every((value) => value.workspaceId === setup.workspace.id)).toBe(true);
    expect(envelopes.every((value) => value.installationId === setup.installation.id)).toBe(true);
  });

  it("rejects malformed team-chat output through the shared contract boundary", async () => {
    const setup = await fixture();
    const plugin = await resolveWorkspaceTeamChatPlugin(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher: vi.fn(async () =>
        Response.json({ outputJson: JSON.stringify({ externalId: "" }) }),
      ) as typeof fetch,
    });

    await expect(
      plugin?.send({ target: { kind: "channel", id: "C1" }, text: "Hello" }),
    ).rejects.toMatchObject({ code: "plugin_output_invalid", status: 502 });
  });

  it("returns null without a team-chat installation and rejects ambiguous providers", async () => {
    const setup = await fixture();
    await db.query("UPDATE plugin_installations SET enabled = false");
    await expect(
      resolveWorkspaceTeamChatPlugin(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      }),
    ).resolves.toBeNull();

    await db.query("UPDATE plugin_installations SET enabled = true");
    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: { ...manifest, id: "acme.other-chat", name: "Other chat" },
      component: new TextEncoder().encode("other component"),
    });
    await expect(
      resolveWorkspaceTeamChatPlugin(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      }),
    ).rejects.toMatchObject({ code: "team_chat_plugin_ambiguous", status: 409 });
  });
});
