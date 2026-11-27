import type { PoolClient } from "@braino/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  deliverDueTimesEdition,
  editionDay,
  latestTimesEditionDay,
  loadTimesEdition,
  publishDueTimesEdition,
  publishTimesEdition,
  rankTimesCandidates,
} from "../times.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function initializedWorkspace() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

describe("Braino Times", () => {
  it("names an edition by the workspace's local calendar day", () => {
    const at = new Date("2026-11-12T00:30:00.000Z");

    expect(editionDay(at, "UTC")).toBe("2026-11-12");
    expect(editionDay(at, "America/Los_Angeles")).toBe("2026-11-11");
    expect(editionDay(at, "Africa/Lagos")).toBe("2026-11-12");
  });

  it("ranks important records deterministically without a model", () => {
    const ranked = rankTimesCandidates([
      {
        id: "reference_1",
        collectionId: "collection_1",
        collectionHandle: "notes",
        nodeType: "reference",
        prose: "A useful reference",
        createdAt: "2026-11-12T07:00:00.000Z",
        links: 0,
        served: 0,
        replaces: false,
      },
      {
        id: "rule_1",
        collectionId: "collection_1",
        collectionHandle: "notes",
        nodeType: "rule",
        prose: "Always verify the release",
        createdAt: "2026-11-12T06:00:00.000Z",
        links: 1,
        served: 1,
        replaces: false,
      },
    ]);

    expect(ranked.map((story) => story.id)).toEqual(["rule_1", "reference_1"]);
    expect(ranked[0]?.headline).toBe("Always verify the release");
  });

  it("publishes once per local day and keeps member and public editions scoped", async () => {
    const initialized = await initializedWorkspace();
    const collection = await db.query<{ id: string; handle: string }>(
      `UPDATE collections SET visibility = 'public'
        WHERE id = (SELECT id FROM collections WHERE workspace_id = $1 ORDER BY id LIMIT 1)
        RETURNING id, handle`,
      [initialized.workspace.id],
    );
    const publicCollection = collection.rows[0];
    if (!publicCollection) throw new Error("Expected an initialized collection.");
    const privateCollection = await db.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM collections
        WHERE workspace_id = $1 AND id <> $2 ORDER BY id LIMIT 1`,
      [initialized.workspace.id, publicCollection.id],
    );
    const privateRow = privateCollection.rows[0];
    if (!privateRow) throw new Error("Expected a private initialized collection.");

    await db.query(
      `INSERT INTO nodes
         (id, collection_id, node_type, lifecycle, prose, locator, created_at, updated_at)
       VALUES
         ('rule_public', $1, 'rule', 'active', 'Public operating rule', NULL,
          '2026-11-12T07:00:00.000Z', '2026-11-12T07:00:00.000Z'),
         ('decision_private', $2, 'decision', 'active', 'Private product decision', NULL,
          '2026-11-12T06:00:00.000Z', '2026-11-12T06:00:00.000Z')`,
      [publicCollection.id, privateRow.id],
    );
    const at = new Date("2026-11-12T08:05:00.000Z");

    const published = await publishTimesEdition(client(), {
      workspaceId: initialized.workspace.id,
      at,
      baseUrl: "https://braino.example",
    });
    expect(published).toMatchObject({ day: "2026-11-12", title: "The Acme Times" });
    await expect(
      publishTimesEdition(client(), {
        workspaceId: initialized.workspace.id,
        at: new Date("2026-11-12T12:00:00.000Z"),
        baseUrl: "https://braino.example",
      }),
    ).resolves.toBeNull();
    await expect(latestTimesEditionDay(client(), initialized.workspace.id)).resolves.toBe(
      "2026-11-12",
    );

    await expect(
      loadTimesEdition(client(), {
        workspaceId: initialized.workspace.id,
        day: "2026-11-12",
        userId: null,
      }),
    ).resolves.toEqual({ kind: "hidden" });

    await db.query("UPDATE workspaces SET times_public = true WHERE id = $1", [
      initialized.workspace.id,
    ]);
    const publicEdition = await loadTimesEdition(client(), {
      workspaceId: initialized.workspace.id,
      day: "2026-11-12",
      userId: null,
    });
    expect(publicEdition).toMatchObject({ kind: "edition", public: true });
    if (publicEdition.kind !== "edition") throw new Error("Expected a public edition.");
    expect(publicEdition.stories.map((story) => story.id)).toEqual(["rule_public"]);

    const memberEdition = await loadTimesEdition(client(), {
      workspaceId: initialized.workspace.id,
      day: "2026-11-12",
      userId: initialized.owner.id,
    });
    expect(memberEdition).toMatchObject({ kind: "edition", public: false });
    if (memberEdition.kind !== "edition") throw new Error("Expected a member edition.");
    expect(memberEdition.stories.map((story) => story.id)).toEqual([
      "rule_public",
      "decision_private",
    ]);
  });

  it("waits until the first local midnight for a workspace created today", async () => {
    const initialized = await initializedWorkspace();
    await db.query(
      `UPDATE workspaces
          SET times_timezone = 'America/Los_Angeles',
              created_at = '2026-11-12T18:00:00.000Z'
        WHERE id = $1`,
      [initialized.workspace.id],
    );

    await expect(
      publishDueTimesEdition(client(), {
        workspaceId: initialized.workspace.id,
        at: new Date("2026-11-12T20:00:00.000Z"),
        baseUrl: "https://braino.example",
      }),
    ).resolves.toBeNull();
    await expect(
      publishDueTimesEdition(client(), {
        workspaceId: initialized.workspace.id,
        at: new Date("2026-11-13T08:05:00.000Z"),
        baseUrl: "https://braino.example",
      }),
    ).resolves.toMatchObject({ day: "2026-11-13" });
  });

  it("delivers each published edition once through installed email and team chat", async () => {
    const initialized = await initializedWorkspace();
    await db.query(
      `UPDATE workspaces
          SET times_timezone = 'UTC', created_at = '2026-11-10T00:00:00.000Z'
        WHERE id = $1`,
      [initialized.workspace.id],
    );
    const plugin = await installPlugin(client(), {
      workspaceId: initialized.workspace.id,
      userId: initialized.owner.id,
      manifest: {
        protocolVersion: 2,
        id: "braino.slack",
        name: "Slack",
        version: "1.0.0",
        capabilities: {
          "event.receive": 1,
          "team_chat.connect": 1,
          "team_chat.send": 1,
        },
        permissions: { network: [] },
      },
      component: new TextEncoder().encode("slack component"),
    });
    await db.query(
      `INSERT INTO plugin_event_deliveries
         (id, workspace_id, installation_id, actor_user_id, external_id, kind,
          occurred_at, processed_at, data)
       VALUES
         ('plugin_event_dm', $1, $2, $3, 'slack_event_1', 'team_chat.message',
          '2026-11-11T23:00:00.000Z', '2026-11-11T23:00:01.000Z',
          '{"channelId":"D_OWNER","senderId":"U_OWNER","text":"Hello","messageId":"1","direct":true}')`,
      [initialized.workspace.id, plugin.id, initialized.owner.id],
    );
    const at = new Date("2026-11-12T00:05:00.000Z");
    await publishTimesEdition(client(), {
      workspaceId: initialized.workspace.id,
      at,
      baseUrl: "https://braino.example",
    });
    const emailSend = vi.fn().mockResolvedValue({ externalId: "email_1" });
    const teamChatSend = vi.fn().mockResolvedValue({ externalId: "message_1" });
    const input = {
      workspaceId: initialized.workspace.id,
      at,
      baseUrl: "https://braino.example",
      email: { send: emailSend },
      teamChat: { installation: { installationId: plugin.id }, send: teamChatSend },
    };

    await expect(deliverDueTimesEdition(client(), input)).resolves.toEqual({
      delivered: 2,
      failed: 0,
    });
    await expect(deliverDueTimesEdition(client(), input)).resolves.toEqual({
      delivered: 0,
      failed: 0,
    });

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledWith({
      to: ["owner@example.com"],
      subject: "The Acme Times · 2026-11-12",
      text: expect.stringContaining("https://braino.example/times/2026-11-12"),
    });
    expect(teamChatSend).toHaveBeenCalledTimes(1);
    expect(teamChatSend).toHaveBeenCalledWith({
      target: { kind: "channel", id: "D_OWNER" },
      text: expect.stringContaining("The Acme Times"),
    });
    const deliveries = await db.query<{
      transport: string;
      recipient: string;
      external_id: string;
    }>(
      `SELECT transport, recipient, external_id
         FROM times_deliveries
        ORDER BY transport, recipient`,
    );
    expect(deliveries.rows).toEqual([
      { transport: "email", recipient: initialized.owner.id, external_id: "email_1" },
      { transport: "team_chat", recipient: "D_OWNER", external_id: "message_1" },
    ]);
  });

  it("retries a failed destination without resending successful ones", async () => {
    const initialized = await initializedWorkspace();
    await db.query(
      `UPDATE workspaces
          SET times_timezone = 'UTC', created_at = '2026-11-10T00:00:00.000Z'
        WHERE id = $1`,
      [initialized.workspace.id],
    );
    const at = new Date("2026-11-12T00:05:00.000Z");
    await publishTimesEdition(client(), {
      workspaceId: initialized.workspace.id,
      at,
      baseUrl: "https://braino.example",
    });
    const emailSend = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ externalId: "email_retry" });
    const delivery = (attemptedAt: Date) =>
      deliverDueTimesEdition(client(), {
        workspaceId: initialized.workspace.id,
        at: attemptedAt,
        baseUrl: "https://braino.example",
        email: { send: emailSend },
        teamChat: null,
      });

    await expect(delivery(at)).resolves.toEqual({ delivered: 0, failed: 1 });
    await expect(delivery(new Date(at.getTime() + 4 * 60_000))).resolves.toEqual({
      delivered: 0,
      failed: 0,
    });
    await expect(delivery(new Date(at.getTime() + 5 * 60_000))).resolves.toEqual({
      delivered: 1,
      failed: 0,
    });
    expect(emailSend).toHaveBeenCalledTimes(2);
  });
});
