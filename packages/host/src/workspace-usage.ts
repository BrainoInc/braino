import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  type PoolClient,
  readWorkspaceUsage,
  readWorkspaceUsageBuckets,
  recordWorkspaceOperation,
  withTransaction,
  workspaceUsageWindow,
} from "@doco/db";

import type { WorkspaceUsagePeriod, WorkspaceUsageReport } from "@doco/shared";

const queryWorkspaces = new AsyncLocalStorage<Map<string, string | null>>();

/** A read can discover its authorized workspace(s) below the transport boundary. */
export function includeQueryWorkspace(workspaceId: string, userId?: string | null): void {
  const workspaces = queryWorkspaces.getStore();
  if (workspaces) workspaces.set(workspaceId, workspaces.get(workspaceId) ?? userId ?? null);
}

/** Meter an externally initiated read once per workspace, after its result is known. */
export async function measureWorkspaceQuery<T>(
  run: () => Promise<T>,
  succeeded: (result: T) => boolean,
  workspaceId?: string,
  userId: string | null = null,
): Promise<T> {
  const workspaces = new Map<string, string | null>();
  if (workspaceId) workspaces.set(workspaceId, userId);
  const result = await queryWorkspaces.run(workspaces, run);
  if (workspaces.size && succeeded(result)) {
    const operationId = randomUUID();
    await withTransaction(async (client) => {
      for (const [id, memberId] of workspaces)
        await recordWorkspaceOperation(client, id, "query", operationId, memberId ?? userId);
    });
  }
  return result;
}

async function memberWorkspaceId(
  client: PoolClient,
  handle: string,
  userId: string,
  memberId: string | null,
) {
  await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
  const { rows } = await client.query<{ id: string }>(
    `SELECT w.id FROM workspaces w JOIN workspace_users u ON u.workspace_id = w.id
       WHERE w.handle = $1 AND u.user_id = $2
         AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM workspace_users m WHERE m.workspace_id=w.id AND m.user_id=$3))`,
    [handle, userId, memberId],
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
  memberId: string | null = null,
): Promise<WorkspaceUsageReport | null> {
  return withTransaction(async (client) => {
    const workspaceId = await memberWorkspaceId(client, handle, userId, memberId);
    if (!workspaceId) return null;
    const { rows: members } = await client.query<{ id: string; name: string }>(
      `SELECT u.id,
      CASE WHEN u.name IS NOT NULL AND u.username IS NOT NULL THEN u.name || ' (@' || u.username || ')'
           ELSE coalesce(u.name,u.username,u.id) END AS name
      FROM workspace_users m JOIN users u ON u.id=m.user_id
      WHERE m.workspace_id=$1 ORDER BY lower(coalesce(u.name,u.username,u.id)),u.id`,
      [workspaceId],
    );
    const month = await readWorkspaceUsageBuckets(
      client,
      workspaceId,
      {
        start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        end: now,
      },
      "24 hours",
      memberId,
    );
    const fiveHours = await readWorkspaceUsageBuckets(
      client,
      workspaceId,
      {
        start: new Date(now.getTime() - 5 * 60 * 60 * 1000),
        end: now,
      },
      "15 minutes",
      memberId,
    );
    return {
      members,
      memberId,
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
  const memberId = url.searchParams.get("member") || null;
  return withTransaction(async (client) => {
    const workspaceId = await memberWorkspaceId(client, handle, userId, memberId);
    return workspaceId
      ? json(await readWorkspaceUsage(client, workspaceId, window, memberId))
      : json({ error: "Workspace not found." }, 404);
  });
}
