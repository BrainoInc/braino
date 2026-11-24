import type { PoolClient } from "pg";
import { beforeEach, expect, it } from "vitest";
import { readWorkspaceUsage, recordWorkspaceOperation } from "../workspace-usage.js";
import { freshDb } from "./fresh-db.js";

let db: Awaited<ReturnType<typeof freshDb>>;
const client = () => db as unknown as PoolClient;
const window = { start: new Date("2020-01-01Z"), end: new Date("2100-01-01Z") };
beforeEach(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('w1','one','One'), ('w2','two','Two');
    INSERT INTO collections (id, handle, owner_id, workspace_id, data) VALUES ('c1','docs','w1','w1','{}');
  `);
});

it("meters committed source changes once and preserves usage after collection deletion", async () => {
  await db.exec(`
    INSERT INTO nodes (id, collection_id, node_type, prose) VALUES ('log_a','c1','log','abcd');
    UPDATE nodes SET prose='abcd', updated_at=now();
  `);
  await db.exec(`BEGIN;
    UPDATE nodes SET prose='rolled back';
    ROLLBACK;`);
  await db.exec(`
    UPDATE nodes SET prose='ééééé';
  `);
  expect(await readWorkspaceUsage(client(), "w1", window)).toMatchObject({
    ingestedTokens: 3,
    lifetimeIngestedTokens: 3,
    storedBytes: 10,
  });
  await db.exec("DELETE FROM collections WHERE id='c1'");
  expect(await readWorkspaceUsage(client(), "w1", window)).toMatchObject({
    ingestedTokens: 3,
    storedBytes: 0,
  });
});

it("isolates workspaces, deduplicates completed operations and integrates retained bytes over [start,end)", async () => {
  for (const workspace of ["w1", "w1", "w2"]) {
    await recordWorkspaceOperation(client(), workspace, "query", "request-1");
  }
  await recordWorkspaceOperation(client(), "w1", "reply", "turn-1");
  expect(await readWorkspaceUsage(client(), "w1", window)).toMatchObject({
    queries: 1,
    replies: 1,
  });
  expect(await readWorkspaceUsage(client(), "w2", window)).toMatchObject({
    queries: 1,
    replies: 0,
  });
  await db.exec(`
    INSERT INTO workspace_content_usage (workspace_id, collection_id, at, ingested_tokens, byte_delta) VALUES
      ('w1','c1','2025-12-31',0,10), ('w1','c1','2026-01-01 00:00:05Z',1,-4),
      ('w1','c1','2026-01-01 00:00:10Z',2,8);
  `);
  expect(
    await readWorkspaceUsage(client(), "w1", {
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-01-01T00:00:10Z"),
    }),
  ).toMatchObject({ ingestedTokens: 1, storedBytes: 6, storageByteSeconds: "80.000000" });
});
