import type { PoolClient } from "@braino/db";
import type { PluginEvent, PluginManifest } from "@braino/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { acceptWorkspaceInvitation, createWorkspaceInvitation } from "../account-links.js";
import { installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import { enqueueTeamChatEvents, processNextTeamChatEvent } from "../team-chat-events.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const manifest: PluginManifest = {
  protocolVersion: 2,
  id: "braino.slack",
  name: "Señor Braino for Slack",
  version: "0.1.0",
  capabilities: { "event.receive": 1, "team_chat.connect": 1, "team_chat.send": 1 },
  permissions: { network: ["slack.com"] },
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
  });
  const invitation = await createWorkspaceInvitation(client(), {
    workspaceId: setup.workspace.id,
    actorId: setup.owner.id,
    email: "reader@example.com",
    role: "reader",
    writeTypes: [],
  });
  const accepted = await acceptWorkspaceInvitation(client(), {
    token: invitation.token,
    username: "reader",
    name: "Slack Reader",
    passwordHash: "scrypt$salt$key",
  });
  return { ...setup, installation, collaborator: accepted.user };
}

const messageEvent: PluginEvent = {
  id: "Ev1",
  occurredAt: "2026-11-16T04:00:00.000Z",
  kind: "team_chat.message",
  data: {
    channelId: "C1",
    senderId: "U1",
    senderEmail: "reader@example.com",
    text: "What changed?",
    messageId: "171.1",
    replyThreadId: "171.1",
  },
};

describe("durable team-chat events", () => {
  it("queues provider retries once and answers through the same installation", async () => {
    const setup = await fixture();
    await expect(
      enqueueTeamChatEvents(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.installation.id,
        events: [messageEvent, messageEvent],
      }),
    ).resolves.toEqual({ created: 1, skipped: 1 });

    const answer = vi.fn(async () => "The release moved model checks into setup.");
    const send = vi.fn(async () => ({ externalId: "171.2" }));
    await expect(processNextTeamChatEvent(client(), { answer, send })).resolves.toBe("processed");

    expect(answer).toHaveBeenCalledWith({
      workspaceId: setup.workspace.id,
      userId: setup.collaborator.id,
      question: "What changed?",
    });
    expect((await db.query("SELECT kind FROM workspace_operations")).rows).toEqual([
      { kind: "reply" },
    ]);
    expect(send).toHaveBeenCalledWith({
      workspaceId: setup.workspace.id,
      installationId: setup.installation.id,
      message: {
        target: { kind: "channel", id: "C1" },
        text: "The release moved model checks into setup.",
        threadId: "171.1",
      },
    });
    const stored = await db.query<{
      attempts: number;
      processed_at: string | null;
      last_error: string | null;
    }>("SELECT attempts, processed_at, last_error FROM plugin_event_deliveries");
    expect(stored.rows).toEqual([
      { attempts: 1, processed_at: expect.any(Date), last_error: null },
    ]);
  });

  it("denies a Slack sender who is not a Braino collaborator without querying the model", async () => {
    const setup = await fixture();
    await expect(
      enqueueTeamChatEvents(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.installation.id,
        events: [
          {
            ...messageEvent,
            id: "Ev-outsider",
            data: { ...messageEvent.data, senderEmail: "outsider@example.com" },
          },
        ],
      }),
    ).resolves.toEqual({ created: 1, skipped: 0 });

    const answer = vi.fn();
    const send = vi.fn(async () => ({ externalId: "171.2" }));
    await expect(processNextTeamChatEvent(client(), { answer, send })).resolves.toBe("processed");
    expect(answer).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          text: "Your Slack email is not a member of this Braino workspace.",
        }),
      }),
    );
  });

  it("disables the exact installation when its provider reports uninstall", async () => {
    const setup = await fixture();
    await enqueueTeamChatEvents(client(), {
      workspaceId: setup.workspace.id,
      installationId: setup.installation.id,
      events: [
        {
          id: "Ev-uninstall",
          occurredAt: "2026-11-16T04:00:00.000Z",
          kind: "team_chat.uninstalled",
          data: {},
        },
      ],
    });
    const answer = vi.fn();
    const send = vi.fn();

    await expect(processNextTeamChatEvent(client(), { answer, send })).resolves.toBe("processed");
    expect(answer).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(
      (await db.query<{ enabled: boolean }>("SELECT enabled FROM plugin_installations")).rows,
    ).toEqual([{ enabled: false }]);
  });

  it("releases failed work for a bounded retry without recording provider secrets", async () => {
    const setup = await fixture();
    await enqueueTeamChatEvents(client(), {
      workspaceId: setup.workspace.id,
      installationId: setup.installation.id,
      events: [messageEvent],
    });
    const answer = vi.fn(async () => {
      throw new Error("xoxb-secret-that-must-not-be-stored");
    });

    await expect(processNextTeamChatEvent(client(), { answer, send: vi.fn() })).resolves.toBe(
      "failed",
    );
    const stored = await db.query<{
      attempts: number;
      locked_at: string | null;
      processed_at: string | null;
      last_error: string | null;
    }>("SELECT attempts, locked_at, processed_at, last_error FROM plugin_event_deliveries");
    expect(stored.rows).toEqual([
      { attempts: 1, locked_at: null, processed_at: null, last_error: "delivery_failed" },
    ]);
  });

  it("returns empty when no delivery is ready", async () => {
    await expect(
      processNextTeamChatEvent(client(), { answer: vi.fn(), send: vi.fn() }),
    ).resolves.toBe("empty");
  });
});
