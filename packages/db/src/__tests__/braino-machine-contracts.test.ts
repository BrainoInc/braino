import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../client.js";
import { MIGRATIONS } from "../schema-embedded.js";
import { freshDb } from "./fresh-db.js";

const LEGACY_NAME = String.fromCharCode(100, 111, 99, 111);

function migrationClient(db: PGlite) {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      if (params) return db.query<T>(sql, params);
      const results = await db.exec(sql);
      return (results[results.length - 1] ?? { rows: [] }) as { rows: T[] };
    },
  };
}

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
      INSERT INTO oauth_authorization_codes (
        code, client_id, user_id, redirect_uri, code_challenge,
        granted_collection_ids, resource, expires_at
      ) VALUES (
        'legacy_auth_code_digest', '${legacyClient}', 'user_legacy',
        'http://localhost/callback', 'challenge', '{collection_legacy}',
        'https://braino.dev/mcp', now() + interval '5 minutes'
      );
      INSERT INTO oauth_access_tokens (
        token, client_id, user_id, granted_collection_ids, resource, expires_at
      ) VALUES (
        'legacy_access_digest', '${legacyClient}', 'user_legacy',
        '{collection_legacy}', 'https://braino.dev/mcp', now() + interval '1 hour'
      );
      INSERT INTO oauth_refresh_tokens (
        token, client_id, user_id, granted_collection_ids, resource, expires_at
      ) VALUES (
        'legacy_refresh_digest', '${legacyClient}', 'user_legacy',
        '{collection_legacy}', 'https://braino.dev/mcp', now() + interval '30 days'
      );
      INSERT INTO oauth_device_authorizations (
        device_code, user_code, client_id, expires_at
      ) VALUES (
        'legacy_device_digest', 'LEGACY01', '${legacyClient}', now() + interval '5 minutes'
      );

      INSERT INTO changesets (collection_id, actor, source, metadata)
      VALUES (
        'collection_legacy',
        'user_legacy',
        'api',
        jsonb_build_object('surface', 'senor_' || '${LEGACY_NAME}', 'client', 'website')
      );

      ALTER FUNCTION braino_allow_history_delete_for_collection()
        RENAME TO ${LEGACY_NAME}_allow_history_delete_for_collection;
      ALTER FUNCTION braino_block_history_mutation()
        RENAME TO ${LEGACY_NAME}_block_history_mutation;
    `);

    await db.exec(`
      CREATE TABLE schema_migrations (
        version integer PRIMARY KEY CHECK (version >= 0),
        name text NOT NULL UNIQUE,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    for (const migration of MIGRATIONS.filter(({ version }) => version < 27)) {
      await db.query(
        "INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [migration.version, migration.name, migration.checksum],
      );
    }
    await applyMigrations(migrationClient(db));
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

  it("revokes non-OAuth credentials whose holders still have the former prefix", async () => {
    const hookTokens = await db.query<{
      revoked: boolean;
      token_sealed: string | null;
    }>("SELECT revoked, token_sealed FROM hook_tokens");
    expect(hookTokens.rows).toEqual([{ revoked: true, token_sealed: null }]);

    const webhooks = await db.query<{ revoked: boolean }>(
      "SELECT revoked FROM incoming_webhooks",
    );
    expect(webhooks.rows).toEqual([{ revoked: true }]);
  });

  it("preserves OAuth clients and every credential issued to them", async () => {
    const counts = await db.query<{ table_name: string; count: number }>(`
      SELECT 'oauth_clients' AS table_name, count(*)::int AS count FROM oauth_clients
      UNION ALL
      SELECT 'oauth_authorization_codes', count(*)::int FROM oauth_authorization_codes
      UNION ALL
      SELECT 'oauth_access_tokens', count(*)::int FROM oauth_access_tokens
      UNION ALL
      SELECT 'oauth_refresh_tokens', count(*)::int FROM oauth_refresh_tokens
      UNION ALL
      SELECT 'oauth_device_authorizations', count(*)::int FROM oauth_device_authorizations
      ORDER BY table_name
    `);
    expect(counts.rows).toEqual([
      { table_name: "oauth_access_tokens", count: 1 },
      { table_name: "oauth_authorization_codes", count: 1 },
      { table_name: "oauth_clients", count: 1 },
      { table_name: "oauth_device_authorizations", count: 1 },
      { table_name: "oauth_refresh_tokens", count: 1 },
    ]);
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
    expect(JSON.stringify(functions.rows).toLowerCase()).not.toContain(
      LEGACY_NAME,
    );

    const activity = await db.query<{ definition: string }>(
      "SELECT pg_get_viewdef('activity_writes') AS definition",
    );
    expect(activity.rows[0]?.definition).toContain("senor_braino");
    expect(activity.rows[0]?.definition).not.toContain(LEGACY_NAME);

    const changeset = await db.query<{ surface: string }>(
      "SELECT metadata->>'surface' AS surface FROM changesets WHERE actor = 'user_legacy'",
    );
    expect(changeset.rows[0]?.surface).toBe("senor_braino");
  });

  it("restores the append-only guard after the controlled history rewrite", async () => {
    await expect(
      db.exec(
        "UPDATE changesets SET metadata = '{}' WHERE actor = 'user_legacy'",
      ),
    ).rejects.toThrow("history append-only");
  });
});
