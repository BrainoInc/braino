import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

/** Use a stable server-side operation identity when a completion can be replayed. */
export async function recordWorkspaceOperation(
  client: PoolClient,
  workspaceId: string,
  kind: "query" | "reply",
  operationId: string = randomUUID(),
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_operations (workspace_id, kind, operation_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [workspaceId, kind, operationId],
  );
}

export interface UsageWindow {
  start: Date;
  end: Date;
}

/** Defaults to month-to-date in UTC. API windows include start and exclude end. */
export function workspaceUsageWindow(
  params: URLSearchParams,
  now = new Date(),
): UsageWindow | null {
  const start = params.has("start")
    ? new Date(params.get("start") ?? "")
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = params.has("end") ? new Date(params.get("end") ?? "") : now;
  return start <= end && end <= now ? { start, end } : null;
}

export interface WorkspaceUsage {
  queries: number;
  replies: number;
  ingestedTokens: number;
  lifetimeIngestedTokens: number;
  storedBytes: number;
  /** Exact integral of retained UTF-8 bytes over the reporting window. */
  storageByteSeconds: string;
}

export async function readWorkspaceUsage(
  client: PoolClient,
  workspaceId: string,
  window: UsageWindow,
) {
  const { start, end } = window;
  const { rows } = await client.query<WorkspaceUsage>(
    `SELECT * FROM (
       SELECT count(*) FILTER (WHERE kind = 'query')::float8 AS queries,
              count(*) FILTER (WHERE kind = 'reply')::float8 AS replies
         FROM workspace_operations WHERE workspace_id = $1 AND at >= $2 AND at < $3
     ) operations CROSS JOIN (
       SELECT coalesce(sum(ingested_tokens) FILTER (WHERE at >= $2), 0)::float8 AS "ingestedTokens",
              coalesce(sum(ingested_tokens), 0)::float8 AS "lifetimeIngestedTokens",
              coalesce(sum(byte_delta), 0)::float8 AS "storedBytes",
              coalesce(sum(byte_delta * extract(epoch FROM ($3::timestamptz - greatest(at, $2::timestamptz)))), 0)::text AS "storageByteSeconds"
         FROM workspace_content_usage WHERE workspace_id = $1 AND at < $3
     ) content`,
    [workspaceId, start.toISOString(), end.toISOString()],
  );
  const usage = rows[0];
  if (!usage) throw new Error("Workspace usage aggregation returned no row.");
  return { workspaceId, start: start.toISOString(), end: end.toISOString(), ...usage };
}
