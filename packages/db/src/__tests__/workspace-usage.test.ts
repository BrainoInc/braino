import type { PoolClient } from "pg";
import { beforeEach, expect, it } from "vitest";
import {
  readWorkspaceUsage,
  recordQueryEvent,
  recordWorkspaceReply,
  setWorkspaceUsageActor,
} from "../workspace-usage.js";
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

it("transfers retained bytes across workspaces without replaying ingestion", async () => {
  await db.exec(`
    INSERT INTO nodes (id, collection_id, node_type, prose) VALUES ('log_a','c1','log','abcd');
    UPDATE collections SET workspace_id='w2' WHERE id='c1';
    UPDATE nodes SET prose='efgh' WHERE id='log_a';
  `);
  expect(await readWorkspaceUsage(client(), "w1", window)).toMatchObject({
    storedBytes: 0,
    ingestedTokens: 1,
  });
  expect(await readWorkspaceUsage(client(), "w2", window)).toMatchObject({
    storedBytes: 4,
    ingestedTokens: 1,
  });
});

it("isolates workspaces, deduplicates completed operations and integrates retained bytes over [start,end)", async () => {
  await db.exec("INSERT INTO query_events(workspace_id,source) VALUES ('w1','ui'),('w2','ui')");
  await recordWorkspaceReply(client(), "w1", "turn-1");
  await recordWorkspaceReply(client(), "w1", "turn-1");
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

it("attributes revisions only inside the member's write transaction", async () => {
  await db.exec(`INSERT INTO users(id,username,data) VALUES ('a','a','{}');
    INSERT INTO workspace_users(workspace_id,user_id,role) VALUES ('w1','a','owner');
    BEGIN`);
  await setWorkspaceUsageActor(client(), "a");
  await db.exec(`INSERT INTO nodes(id,collection_id,node_type,prose) VALUES ('log_a','c1','log','four');
    COMMIT; UPDATE nodes SET prose='anonymous';`);
  expect(
    (
      await db.query(
        "SELECT user_id,ingested_tokens::int AS tokens FROM workspace_content_usage ORDER BY tokens",
      )
    ).rows,
  ).toEqual([
    { user_id: "a", tokens: 1 },
    { user_id: null, tokens: 3 },
  ]);
});

it("reads the activity history once across editions and keeps imports workspace-wide", async () => {
  await db.exec(`INSERT INTO query_events(workspace_id,actor,source,metadata,at) VALUES
    ('w1','alice','mcp','{"searched_tokens":70}','2026-05-01T02:15Z'),
    ('w1','bob','ui','{"searched_tokens":20}','2026-05-01T02:30Z'),
    ('w1','alice','ui',null,'2026-05-01T03:00Z'),('w2','alice','ui',null,'2026-05-01T02:30Z');
    INSERT INTO workspace_operations(workspace_id,kind,operation_id,at) VALUES ('w1','query','old-duplicate','2026-05-01T02:15Z');
    INSERT INTO changesets(collection_id,actor,source,recorded_at) VALUES
    ('c1','alice','ui','2026-05-01T02:10Z'),('c1','bob','mcp','2026-05-01T02:20Z'),
    ('c1',null,'import','2026-05-01T02:22Z');
    INSERT INTO nodes(id, collection_id,node_type,locator,updated_at)
    VALUES ('ref_a','c1','reference','https://github.com/a/b/issues/1','2026-05-01T02:40Z');`);
  const range = { start: new Date("2026-05-01T02:00Z"), end: new Date("2026-05-01T03:00Z") };
  expect(await readWorkspaceUsage(client(), "w1", range)).toMatchObject({
    queries: 2,
    searchedTokens: 90,
    writes: 2,
    imports: 1,
  });
  expect(await readWorkspaceUsage(client(), "w1", range, "alice")).toMatchObject({
    queries: 1,
    searchedTokens: 70,
    writes: 1,
    imports: 1,
  });
});

it("records the search corpus once using the collection token snapshot", async () => {
  await db.exec(`INSERT INTO nodes(id,collection_id,node_type,prose) VALUES ('log_1','c1','log','abcdefgh');
    SELECT refresh_collection_tokens();`);
  await recordQueryEvent(client(), {
    workspaceId: "w1",
    actor: "alice",
    source: "mcp",
    metadata: { brief_id: "brief_1" },
    searchedRecords: true,
  });
  const { rows } = await db.query("SELECT actor,source,metadata FROM query_events");
  expect(rows).toEqual([
    { actor: "alice", source: "mcp", metadata: { brief_id: "brief_1", searched_tokens: 2 } },
  ]);
  expect(await readWorkspaceUsage(client(), "w1", window)).toMatchObject({
    queries: 1,
    searchedTokens: 2,
  });
});
