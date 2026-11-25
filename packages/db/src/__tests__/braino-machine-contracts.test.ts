import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

const LEGACY_NAME = String.fromCharCode(100, 111, 99, 111);

describe("Braino machine-contract migration", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = await freshDb();
    const legacyWorkspaceColumn = `${LEGACY_NAME}_workspace_id`;
    const legacyBrief = `${LEGACY_NAME}_brief`;
    const legacyClient = `${LEGACY_NAME}_client_existing`;
    const legacyRebrandKey = `${LEGACY_NAME}_channel_rebrand_completed_at`;

    await db.exec(`
      ALTER TABLE group_chat_installations
        RENAME COLUMN braino_workspace_id TO ${legacyWorkspaceColumn};

      ALTER TABLE agent_results DROP CONSTRAINT agent_results_tool_check;
      ALTER TABLE agent_results ADD CONSTRAINT agent_results_tool_check
        CHECK (tool IN ('${legacyBrief}', '${LEGACY_NAME}_search'));

      INSERT INTO users (id, data) VALUES ('user_legacy', '{}');
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_legacy', 'legacy', 'Legacy');
      INSERT INTO collections (id, handle, owner_id, workspace_id, data)
      VALUES ('collection_legacy', 'legacy-docs', 'workspace_legacy', 'workspace_legacy', '{}');

      INSERT INTO group_chat_installations
        (id, provider, workspace_id, ${legacyWorkspaceColumn}, data)
      VALUES
        ('installation_legacy', 'slack', 'slack_team', 'workspace_legacy',
         jsonb_build_object('${legacyRebrandKey}', '2026-11-01T00:00:00Z'));

      INSERT INTO agent_results (id, actor, tool, query, source, context)
      VALUES ('result_legacy', 'user_legacy', '${legacyBrief}', 'why', 'mcp', '{}');

      INSERT INTO hook_tokens
        (token, token_sealed, workspace_id, created_by_user_id)
      VALUES ('legacy_hook_digest', 'sealed', 'workspace_legacy', 'user_legacy');
      INSERT INTO incoming_webhooks
        (token, collection_id, created_by_user_id, label)
      VALUES ('legacy_webhook_digest', 'collection_legacy', 'user_legacy', 'Legacy');
      INSERT INTO oauth_clients (client_id, redirect_uris)
      VALUES ('${legacyClient}', '{http://localhost/callback}');

      ALTER FUNCTION braino_allow_history_delete_for_collection()
        RENAME TO ${LEGACY_NAME}_allow_history_delete_for_collection;
      ALTER FUNCTION braino_block_history_mutation()
        RENAME TO ${LEGACY_NAME}_block_history_mutation;
    `);

    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "027_braino_machine_contracts.sql"),
      "utf8",
    );
    await db.exec(migration);
  });

  afterAll(() => db.close());

  it("renames durable identifiers and values without losing workspace bindings", async () => {
    const installation = await db.query<{
      braino_workspace_id: string;
      data: Record<string, string>;
    }>(
      `SELECT braino_workspace_id, data
         FROM group_chat_installations
        WHERE id = 'installation_legacy'`,
    );
    expect(installation.rows[0]).toEqual({
      braino_workspace_id: "workspace_legacy",
      data: { braino_channel_rebrand_completed_at: "2026-11-01T00:00:00Z" },
    });

    const result = await db.query<{ tool: string }>(
      "SELECT tool FROM agent_results WHERE id = 'result_legacy'",
    );
    expect(result.rows[0]?.tool).toBe("braino_brief");
  });

  it("revokes credentials whose holders still have the former prefix", async () => {
    const hookTokens = await db.query<{ revoked: boolean; token_sealed: string | null }>(
      "SELECT revoked, token_sealed FROM hook_tokens",
    );
    expect(hookTokens.rows).toEqual([{ revoked: true, token_sealed: null }]);

    const webhooks = await db.query<{ revoked: boolean }>("SELECT revoked FROM incoming_webhooks");
    expect(webhooks.rows).toEqual([{ revoked: true }]);

    const clients = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM oauth_clients",
    );
    expect(clients.rows[0]?.count).toBe("0");
  });

  it("replaces database functions and views that carried the former contract", async () => {
    const functions = await db.query<{ name: string; definition: string }>(`
      SELECT proname AS name, pg_get_functiondef(oid) AS definition
        FROM pg_proc
       WHERE proname LIKE '%history%'
    `);
    expect(functions.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "braino_allow_history_delete_for_collection",
        "braino_block_history_mutation",
      ]),
    );
    expect(JSON.stringify(functions.rows).toLowerCase()).not.toContain(LEGACY_NAME);

    const activity = await db.query<{ definition: string }>(
      "SELECT pg_get_viewdef('activity_writes') AS definition",
    );
    expect(activity.rows[0]?.definition).toContain("senor_braino");
    expect(activity.rows[0]?.definition).not.toContain(LEGACY_NAME);
  });
});
