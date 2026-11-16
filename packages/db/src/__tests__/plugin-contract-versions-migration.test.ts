import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("plugin capability contract migration", () => {
  it("upgrades installed protocol-one manifests without replacing their artifacts", async () => {
    await db.exec(`
      INSERT INTO workspaces (id, handle, name, constitution)
      VALUES ('workspace_test', 'test', 'Test', '');
      INSERT INTO users (id, username, name, email, password_hash, data)
      VALUES ('user_test', 'test', 'Test', 'test@example.com', 'hash', '{}');
      INSERT INTO plugin_artifacts (digest, component)
      VALUES (
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        '\\x00'
      );
      INSERT INTO plugin_installations
        (id, workspace_id, manifest, artifact_digest,
         created_by_user_id, updated_by_user_id)
      VALUES (
        'plugin_installation_old',
        'workspace_test',
        '{
          "protocolVersion": 1,
          "id": "acme.models",
          "name": "Acme models",
          "version": "1.0.0",
          "capabilities": ["chat.complete", "embedding.embed"],
          "permissions": {"network": ["models.example.com"]}
        }',
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'user_test',
        'user_test'
      );
    `);

    const migration = await readFile(
      new URL("../../migrations/016_plugin_contract_versions.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const result = await db.query<{ manifest: Record<string, unknown>; artifact_digest: string }>(
      "SELECT manifest, artifact_digest FROM plugin_installations WHERE id = 'plugin_installation_old'",
    );
    expect(result.rows).toEqual([
      {
        manifest: {
          protocolVersion: 2,
          id: "acme.models",
          name: "Acme models",
          version: "1.0.0",
          capabilities: { "chat.complete": 1, "embedding.embed": 1 },
          permissions: { network: ["models.example.com"] },
        },
        artifact_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);
  });
});
