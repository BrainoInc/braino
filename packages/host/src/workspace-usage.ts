import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type PoolClient,
  readWorkspaceUsage,
  readWorkspaceUsageBuckets,
  recordWorkspaceOperation,
  withClient,
  withTransaction,
  workspaceUsageWindow,
} from "@doco/db";

import type { WorkspaceUsagePeriod, WorkspaceUsageReport } from "@doco/shared";

const queryWorkspaces = new AsyncLocalStorage<Set<string>>();

/** A read can discover its authorized workspace(s) below the transport boundary. */
export function includeQueryWorkspace(workspaceId: string): void {
  queryWorkspaces.getStore()?.add(workspaceId);
}

/** Meter an externally initiated read once per workspace, after its result is known. */
export async function measureWorkspaceQuery<T>(
  run: () => Promise<T>,
  succeeded: (result: T) => boolean,
  workspaceId?: string,
): Promise<T> {
  const workspaces = new Set(workspaceId ? [workspaceId] : []);
  const result = await queryWorkspaces.run(workspaces, run);
  if (workspaces.size && succeeded(result)) {
    const operationId = randomUUID();
    await withTransaction(async (client) => {
      for (const id of workspaces) await recordWorkspaceOperation(client, id, "query", operationId);
    });
  }
  return result;
}

async function memberWorkspaceId(client: PoolClient, handle: string, userId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT w.id FROM workspaces w JOIN workspace_users u ON u.workspace_id = w.id
       WHERE w.handle = $1 AND u.user_id = $2`,
    [handle, userId],
  );
  return rows[0]?.id;
}

function summarizePeriod(
  rows: Awaited<ReturnType<typeof readWorkspaceUsageBuckets>>,
): WorkspaceUsagePeriod {
  let queries = 0;
  let replies = 0;
  let ingestedTokens = 0;
  const buckets: WorkspaceUsagePeriod["buckets"] = [];
  for (const row of rows) {
    if (row.start === row.end) continue;
    buckets.push({
      start: row.start,
      end: row.end,
      queries: row.queries,
      replies: row.replies,
      ingestedTokens: row.ingestedTokens,
      storedBytes: row.storedBytes,
    });
    queries += row.queries;
    replies += row.replies;
    ingestedTokens += row.ingestedTokens;
  }
  return {
    queries,
    replies,
    ingestedTokens,
    buckets,
  };
}

/** The membership check and both windows see the same committed usage. */
export async function getWorkspaceUsageReport(
  handle: string,
  userId: string,
  now = new Date(),
): Promise<WorkspaceUsageReport | null> {
  return withTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const workspaceId = await memberWorkspaceId(client, handle, userId);
    if (!workspaceId) return null;
    const month = await readWorkspaceUsageBuckets(
      client,
      workspaceId,
      {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: now,
      },
      "24 hours",
    );
    const fiveHours = await readWorkspaceUsageBuckets(
      client,
      workspaceId,
      {
        start: new Date(now.getTime() - 5 * 60 * 60 * 1000),
        end: now,
      },
      "15 minutes",
    );
    return {
      asOf: now.toISOString(),
      storedBytes: fiveHours.at(-1)?.storedBytes ?? 0,
      month: summarizePeriod(month),
      fiveHours: summarizePeriod(fiveHours),
    };
  });
}

/** Both hosts authenticate the session locally; workspace membership is checked here. */
export async function workspaceUsageResponse(
  url: URL,
  handle: string,
  userId: string | null,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (!userId) return json({ error: "Authentication required." }, 401);
  const window = workspaceUsageWindow(url.searchParams);
  if (!window)
    return json({ error: "Use a valid start and end at or before the current time." }, 400);
  return withClient(async (client) => {
    const workspaceId = await memberWorkspaceId(client, handle, userId);
    return workspaceId
      ? json(await readWorkspaceUsage(client, workspaceId, window))
      : json({ error: "Workspace not found." }, 404);
  });
}
