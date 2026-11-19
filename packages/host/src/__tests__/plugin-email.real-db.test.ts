import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { connectWorkspaceEmailPlugin, resolveWorkspaceEmailPlugin } from "../plugin-email.js";
import { installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "email-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";
const manifest: PluginManifest = {
  protocolVersion: 2,
  id: "braino.resend",
  name: "Resend",
  version: "0.1.0",
  capabilities: { "email.send": 1 },
  permissions: { network: ["api.resend.com"] },
  configurationSchema: {
    type: "object",
    properties: { sender: { type: "string" } },
    required: ["sender"],
    additionalProperties: false,
  },
  secretSchema: {
    type: "object",
    properties: { api_key: { type: "string" } },
    required: ["api_key"],
    additionalProperties: false,
  },
};

async function workspace(handle = "acme") {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: handle,
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

describe("workspace email plugin", () => {
  it("installs one provider, verifies it through the shared contract, and sends through it", async () => {
    const setup = await workspace();
    const fetcher = vi.fn(async () =>
      Response.json({ outputJson: JSON.stringify({ externalId: "email_123" }) }),
    ) as typeof fetch;

    const connected = await connectWorkspaceEmailPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest,
      component: new TextEncoder().encode("resend component"),
      configuration: { sender: "Braino <hello@example.com>" },
      secrets: { api_key: "re_workspace" },
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      verificationRecipient: "owner@example.com",
      fetcher,
    });

    expect(connected.verification).toEqual({ externalId: "email_123" });
    const plugin = await resolveWorkspaceEmailPlugin(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher,
    });
    await expect(
      plugin?.send({ to: ["person@example.com"], subject: "Hello", text: "Body" }),
    ).resolves.toEqual({ externalId: "email_123" });

    const envelopes = fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(envelopes).toHaveLength(2);
    expect(envelopes.every((value) => value.capability === "email.send")).toBe(true);
    expect(JSON.parse(envelopes[0].inputJson)).toMatchObject({
      to: ["owner@example.com"],
      subject: "Your Braino email provider is connected",
    });
  });

  it("enables only the newly connected email provider", async () => {
    const setup = await workspace();
    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: { ...manifest, id: "acme.postmark", name: "Postmark" },
      component: new TextEncoder().encode("postmark component"),
    });
    const fetcher = vi.fn(async () =>
      Response.json({ outputJson: JSON.stringify({ externalId: "email_123" }) }),
    ) as typeof fetch;

    await connectWorkspaceEmailPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest,
      component: new TextEncoder().encode("resend component"),
      configuration: { sender: "Braino <hello@example.com>" },
      secrets: { api_key: "re_workspace" },
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      verificationRecipient: "owner@example.com",
      fetcher,
    });

    const rows = await db.query<{ plugin_id: string; enabled: boolean }>(
      "SELECT manifest->>'id' AS plugin_id, enabled FROM plugin_installations ORDER BY plugin_id",
    );
    expect(rows.rows).toEqual([
      { plugin_id: "acme.postmark", enabled: false },
      { plugin_id: "braino.resend", enabled: true },
    ]);
  });

  it("rejects ambiguous enabled providers", async () => {
    const setup = await workspace();
    for (const [id, name] of [
      ["braino.resend", "Resend"],
      ["acme.postmark", "Postmark"],
    ] as const) {
      await installPlugin(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        manifest: { ...manifest, id, name },
        component: new TextEncoder().encode(id),
      });
    }
    await expect(
      resolveWorkspaceEmailPlugin(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      }),
    ).rejects.toMatchObject({ code: "email_plugin_ambiguous", status: 409 });
  });
});
