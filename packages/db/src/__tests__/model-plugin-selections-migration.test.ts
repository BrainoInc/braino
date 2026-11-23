import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("model plugin selection migration", () => {
  it("preserves the enabled providers as active and keeps every model plugin installed", async () => {
    await db.exec(`
      DROP TABLE workspace_model_plugin_selections;
      DROP INDEX plugin_installations_workspace_id_idx;
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_models', 'models', 'Models');
      INSERT INTO users (id, username, name, email, data)
      VALUES ('user_owner', 'owner', 'Owner', 'owner@example.com', '{}');
      INSERT INTO plugin_artifacts (digest, component)
      VALUES ('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'component');
      INSERT INTO plugin_installations
        (id, workspace_id, manifest, artifact_digest, configuration, enabled,
         verified_at, verified_embedding_dimensions,
         created_by_user_id, updated_by_user_id, updated_at)
      VALUES
        ('chat_local', 'workspace_models',
         '{"id":"braino.ollama-chat","capabilities":{"chat.complete":1}}',
         'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         '{"model":"qwen3.5:2b"}', true, NULL, NULL,
         'user_owner', 'user_owner', '2026-11-20T10:00:00Z'),
        ('chat_cloud', 'workspace_models',
         '{"id":"braino.openai-chat","capabilities":{"chat.complete":1}}',
         'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         '{"model":"gpt-4.1-mini"}', false, NULL, NULL,
         'user_owner', 'user_owner', '2026-11-19T10:00:00Z'),
        ('embedding_local', 'workspace_models',
         '{"id":"braino.ollama-embedding","capabilities":{"embedding.embed":1}}',
         'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         '{"model":"embeddinggemma-2:270m"}', true, now(), 768,
         'user_owner', 'user_owner', '2026-11-20T10:00:00Z');
    `);

    const migration = await readFile(
      new URL("../../migrations/022_model_plugin_selections.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const selections = await db.query<{ capability: string; installation_id: string }>(
      `SELECT capability, installation_id
         FROM workspace_model_plugin_selections
        ORDER BY capability`,
    );
    expect(selections.rows).toEqual([
      { capability: "chat.complete", installation_id: "chat_local" },
      { capability: "embedding.embed", installation_id: "embedding_local" },
    ]);
    const installed = await db.query<{ id: string; enabled: boolean }>(
      "SELECT id, enabled FROM plugin_installations ORDER BY id",
    );
    expect(installed.rows).toEqual([
      { id: "chat_cloud", enabled: true },
      { id: "chat_local", enabled: true },
      { id: "embedding_local", enabled: true },
    ]);
    await expect(
      db.query("DELETE FROM plugin_installations WHERE id = 'chat_local'"),
    ).rejects.toThrow();
  });
});
