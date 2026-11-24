import type { PoolClient } from "@doco/db";
import { installTestDatabaseClient } from "@doco/db/test-support";
import { afterEach, beforeEach, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  getWorkspaceUsageReport,
  includeQueryWorkspace,
  measureWorkspaceQuery,
  workspaceUsageResponse,
} from "../workspace-usage.js";

let db: Awaited<ReturnType<typeof freshDb>>;
let restore: () => void;
beforeEach(async () => {
  db = await freshDb();
  restore = installTestDatabaseClient(db as unknown as PoolClient);
  await db.exec(`INSERT INTO workspaces (id,handle,name) VALUES ('w1','one','One'),('w2','two','Two');
    INSERT INTO users (id,username,data) VALUES ('member','user','{}');
    INSERT INTO workspace_users (workspace_id,user_id,role) VALUES ('w1','member','owner')`);
});
afterEach(() => restore());

it("counts each participating workspace once only after the outer query succeeds", async () => {
  async function query(status: number) {
    includeQueryWorkspace("w1");
    includeQueryWorkspace("w1");
    includeQueryWorkspace("w2");
    return new Response(null, { status });
  }
  const ok = (response: Response) => response.ok;
  await measureWorkspaceQuery(() => query(404), ok);
  await expect(
    measureWorkspaceQuery(async () => {
      await query(200);
      throw Error("failed");
    }, ok),
  ).rejects.toThrow();
  await measureWorkspaceQuery(() => query(200), ok);
  expect(
    (await db.query("SELECT workspace_id FROM workspace_operations ORDER BY workspace_id")).rows,
  ).toEqual([{ workspace_id: "w1" }, { workspace_id: "w2" }]);
});

it("serves a member's window and hides other workspaces", async () => {
  const url = new URL("https://braino.example/api/v1/workspaces/one/usage.json");
  expect((await workspaceUsageResponse(url, "one", null)).status).toBe(401);
  expect((await workspaceUsageResponse(url, "two", "member")).status).toBe(404);
  expect(await (await workspaceUsageResponse(url, "one", "member")).json()).toMatchObject({
    workspaceId: "w1",
    queries: 0,
  });
  url.searchParams.set("start", "invalid");
  expect((await workspaceUsageResponse(url, "one", "member")).status).toBe(400);
});

it("compares the UTC month and rolling five hours across midnight for workspace members", async () => {
  const now = new Date("2026-12-01T02:00:00Z");
  await db.exec(`
    INSERT INTO workspace_operations(workspace_id,kind,operation_id,at) VALUES
      ('w1','query','before','2026-11-30T20:59:59Z'),
      ('w1','query','five','2026-11-30T21:00:00Z'),
      ('w1','reply','month','2026-12-01T00:00:00Z'),
      ('w1','query','end','2026-12-01T02:00:00Z'),
      ('w2','query','other','2026-12-01T01:30:00Z');
    INSERT INTO workspace_content_usage(workspace_id,collection_id,at,ingested_tokens,byte_delta)
      VALUES ('w1','c1','2026-11-30T21:00:00Z',5,100),('w1','c1','2026-12-01T01:00:00Z',2,100);
    UPDATE workspace_users SET role='reader' WHERE user_id='member';
  `);
  expect(await getWorkspaceUsageReport("two", "member", now)).toBeNull();
  expect(await getWorkspaceUsageReport("one", "member", now)).toMatchObject({
    asOf: now.toISOString(),
    storedBytes: 200,
    month: { queries: 0, replies: 1, ingestedTokens: 2 },
    fiveHours: { queries: 1, replies: 1, ingestedTokens: 7 },
  });
  const report = await getWorkspaceUsageReport("one", "member", now);
  expect(report?.month.buckets).toEqual([
    {
      start: "2026-12-01T00:00:00.000Z",
      end: now.toISOString(),
      queries: 0,
      replies: 1,
      ingestedTokens: 2,
      storedBytes: 200,
    },
  ]);
  expect(report?.fiveHours.buckets).toHaveLength(20);
  expect(report?.fiveHours.buckets[0]).toMatchObject({
    queries: 1,
    ingestedTokens: 5,
    storedBytes: 100,
  });
  expect(report?.fiveHours.buckets[1]).toMatchObject({
    queries: 0,
    replies: 0,
    ingestedTokens: 0,
    storedBytes: 100,
  });
  expect(report?.fiveHours.buckets[12]).toMatchObject({ replies: 1 });
  expect(report?.fiveHours.buckets[16]).toMatchObject({
    storedBytes: 200,
    ingestedTokens: 2,
  });
  const midnight = await getWorkspaceUsageReport("one", "member", new Date("2026-12-01T00:00:00Z"));
  expect(midnight?.month).toMatchObject({
    queries: 0,
    replies: 0,
    buckets: [],
  });
});

it("carries retained bytes across the window and lowers the balance when text is removed", async () => {
  const now = new Date("2026-12-02T00:07:12.345Z");
  await db.exec(`INSERT INTO workspace_content_usage(workspace_id,collection_id,at,ingested_tokens,byte_delta)
     VALUES ('w1','c1','2026-11-01T00:00:00Z',50,100),('w1','c1','2026-12-02T00:02:12.345Z',3,-40);`);
  const report = await getWorkspaceUsageReport("one", "member", now);
  expect(report?.month.buckets).toHaveLength(2);
  expect(report?.month.buckets[0]?.storedBytes).toBe(100);
  expect(report?.month.buckets[1]?.storedBytes).toBe(60);
  expect(report?.fiveHours.buckets[0]?.storedBytes).toBe(100);
  expect(report?.fiveHours.buckets[0]?.start).toBe("2026-12-01T19:07:12.345Z");
  expect(report?.fiveHours.buckets.at(-1)).toMatchObject({
    start: "2026-12-01T23:52:12.345Z",
    end: now.toISOString(),
    ingestedTokens: 3,
    storedBytes: 60,
  });
  expect(report?.storedBytes).toBe(60);
});

it("filters both windows by a current member while retaining the workspace storage balance", async () => {
  const now = new Date("2026-12-02T07:00:00Z");
  await db.exec(`INSERT INTO users (id, username, name, data) VALUES ('other','sam','Sam','{}'),('outside','eve',NULL,'{}');
    INSERT INTO workspace_users(workspace_id,user_id,role) VALUES ('w1','other','reader'),('w2','outside','owner');
    INSERT INTO workspace_operations(workspace_id,kind,operation_id,user_id,at) VALUES
    ('w1','query','first','member','2026-12-01T00:00Z'),('w1','reply','second','other','2026-12-02T06:55Z'),
    ('w1','reply','third','member','2026-12-02T06:55Z'),('w1','query','legacy',NULL,'2026-12-02T06:55Z');
    INSERT INTO workspace_content_usage(workspace_id,collection_id,ingested_tokens,byte_delta,user_id,at)
    VALUES ('w1','c',7,28,'member','2026-12-02T06:55Z'),('w1','c',10,40,NULL,'2026-12-02T06:55Z');`);
  const report = await getWorkspaceUsageReport("one", "other", now, "member");
  expect(report).toMatchObject({
    memberId: "member",
    storedBytes: 68,
    month: { queries: 1, replies: 1, ingestedTokens: 7 },
    fiveHours: { queries: 0, replies: 1, ingestedTokens: 7 },
  });
  expect(report?.fiveHours.buckets.at(-1)).toMatchObject({
    queries: 0,
    replies: 1,
    ingestedTokens: 7,
    storedBytes: 68,
  });
  expect(report?.members.map((m) => m.id).sort()).toEqual(["member", "other"]);
  expect(await getWorkspaceUsageReport("one", "member", now, "outside")).toBeNull();
  expect(await getWorkspaceUsageReport("one", "outside", now, "other")).toBeNull();
  expect((await getWorkspaceUsageReport("one", "member", now))?.month).toMatchObject({
    queries: 2,
    replies: 2,
    ingestedTokens: 17,
  });
});

it("attributes a successful query once and only to its workspace member", async () => {
  await measureWorkspaceQuery(
    async () => {
      includeQueryWorkspace("w1", "member");
      includeQueryWorkspace("w1");
      includeQueryWorkspace("w2", "member");
    },
    () => true,
  );
  expect(
    (await db.query("SELECT workspace_id,user_id FROM workspace_operations ORDER BY workspace_id"))
      .rows,
  ).toEqual([
    { workspace_id: "w1", user_id: "member" },
    { workspace_id: "w2", user_id: null },
  ]);
});

it("applies the page's member filter to the usage API and rejects IDs outside the workspace", async () => {
  await measureWorkspaceQuery(
    async () => true,
    (x) => x,
    "w1",
    "member",
  );
  await measureWorkspaceQuery(
    async () => true,
    (x) => x,
    "w1",
  );
  const url = new URL("https://braino.example/usage.json?member=member");
  expect(await (await workspaceUsageResponse(url, "one", "member")).json()).toMatchObject({
    memberId: "member",
    queries: 1,
  });
  url.searchParams.set("member", "other-workspace-member");
  expect((await workspaceUsageResponse(url, "one", "member")).status).toBe(404);
});
