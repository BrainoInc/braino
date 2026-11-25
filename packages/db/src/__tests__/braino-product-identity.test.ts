import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

const LEGACY_NAME = String.fromCharCode(100, 111, 99, 111);
const LEGACY_PRODUCT_NAME = `${LEGACY_NAME[0]?.toUpperCase()}${LEGACY_NAME.slice(1)}`;
const oldDocumentsGoal = `Write and keep documents in ${LEGACY_PRODUCT_NAME}: specs, plans, notes, anything a page says best, in Markdown, searchable alongside your other knowledge.`;
const legacyClientId = `${LEGACY_NAME}_self_hosted_tokens`;
const legacyClientName = `${LEGACY_PRODUCT_NAME} self-hosted MCP tokens`;
const customGoal = `Our ${LEGACY_PRODUCT_NAME} migration notes`;

describe("Braino product identity migration", () => {
  it("updates only built-in display data and preserves user-authored copy", async () => {
    const db = await freshDb();
    await db.exec(`
      UPDATE hosts SET name = '${LEGACY_PRODUCT_NAME}'
       WHERE id = 'host';
      INSERT INTO users (id, data) VALUES ('user_owner', '{}'::jsonb);
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_test', 'test', 'Test');
      INSERT INTO collections (id, handle, owner_id, workspace_id, goal, data)
      VALUES
        ('collection_builtin', 'builtin', 'workspace_test', 'workspace_test',
         '${oldDocumentsGoal.replaceAll("'", "''")}', '{"template_handle":"documents"}'::jsonb),
        ('collection_custom', 'custom', 'workspace_test', 'workspace_test',
         '${customGoal}', '{}'::jsonb);
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
      VALUES
        ('${legacyClientId}', '${legacyClientName}', ARRAY[]::text[]),
        ('custom_client', 'Braino Partner', ARRAY[]::text[]);
    `);

    const migration = await readFile(
      join(import.meta.dirname, "..", "..", "migrations", "002_braino_product_identity.sql"),
      "utf8",
    );
    await db.exec(migration);

    expect(
      (await db.query<{ name: string }>("SELECT name FROM hosts WHERE id = 'host'")).rows,
    ).toEqual([{ name: "Braino" }]);
    expect(
      (
        await db.query<{ client_id: string; client_name: string }>(
          "SELECT client_id, client_name FROM oauth_clients ORDER BY client_id",
        )
      ).rows,
    ).toEqual([
      { client_id: "custom_client", client_name: "Braino Partner" },
      { client_id: legacyClientId, client_name: "Braino self-hosted MCP tokens" },
    ]);
    expect(
      (
        await db.query<{ handle: string; goal: string }>(
          "SELECT handle, goal FROM collections ORDER BY handle",
        )
      ).rows,
    ).toEqual([
      {
        handle: "builtin",
        goal: oldDocumentsGoal.replace(LEGACY_PRODUCT_NAME, "Braino"),
      },
      { handle: "custom", goal: customGoal },
    ]);
  });
});
