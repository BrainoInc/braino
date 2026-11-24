import type { PoolClient } from "@doco/db";
import { installTestDatabaseClient } from "@doco/db/test-support";
import { afterEach, beforeEach, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
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
