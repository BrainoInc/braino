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
    month: { queries: 0, replies: 1, ingestedTokens: 2, averageStoredBytes: 150 },
    fiveHours: { queries: 1, replies: 1, ingestedTokens: 7, averageStoredBytes: 120 },
  });
  const midnight = await getWorkspaceUsageReport("one", "member", new Date("2026-12-01T00:00:00Z"));
  expect(midnight?.month).toMatchObject({ queries: 0, replies: 0, averageStoredBytes: 0 });
});
