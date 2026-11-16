import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("plugin event delivery migration", () => {
  it("adds a durable idempotent queue scoped to one plugin installation", async () => {
    await db.exec("DROP TABLE IF EXISTS plugin_event_deliveries");
    const migration = await readFile(
      new URL("../../migrations/018_plugin_event_deliveries.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const columns = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'plugin_event_deliveries'
        ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "id",
      "workspace_id",
      "installation_id",
      "actor_user_id",
      "external_id",
      "kind",
      "occurred_at",
      "data",
      "attempts",
      "available_at",
      "locked_at",
      "processed_at",
      "last_error",
      "created_at",
    ]);
    expect(columns.rows.find((row) => row.column_name === "installation_id")?.is_nullable).toBe(
      "NO",
    );
    expect(columns.rows.find((row) => row.column_name === "actor_user_id")?.is_nullable).toBe(
      "YES",
    );
  });
});
