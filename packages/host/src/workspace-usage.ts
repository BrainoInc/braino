import {
  type PoolClient,
  readWorkspaceUsage,
  readWorkspaceUsageBuckets,
  withTransaction,
  workspaceUsageWindow,
} from "@braino/db";

import type { WorkspaceUsagePeriod, WorkspaceUsageReport } from "@braino/shared";

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
  const buckets = rows
    .filter((row) => row.start !== row.end)
    .map(
      ({
        start,
        end,
        queries,
        writes,
        imports,
        searchedTokens,
        replies,
        ingestedTokens,
        storedBytes,
      }) => ({
        start,
        end,
        queries,
        writes,
        imports,
        searchedTokens,
        replies,
        ingestedTokens,
        storedBytes,
      }),
    );
  const totals = {
    queries: 0,
    writes: 0,
    imports: 0,
    searchedTokens: 0,
    replies: 0,
    ingestedTokens: 0,
  };
  for (const bucket of buckets) {
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += bucket[key];
  }
  return { ...totals, buckets };
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
