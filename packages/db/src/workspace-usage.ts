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

/** Each interval is half-open. Look up its events by workspace and time, carrying
 * the opening storage balance forward even through intervals without writes. */
export async function readWorkspaceUsageBuckets(
  client: PoolClient,
  workspaceId: string,
  { start, end }: UsageWindow,
  step?: "24 hours" | "15 minutes",
) {
  const params = [workspaceId, start.toISOString(), end.toISOString()];
  const spans = step
    ? `SELECT tick AS lo, least(tick + $4::interval, $3::timestamptz) AS hi
         FROM generate_series($2::timestamptz, $3::timestamptz, $4::interval) tick
        WHERE tick < $3 OR tick = $2`
    : "SELECT $2::timestamptz AS lo, $3::timestamptz AS hi";
  if (step) params.push(step);
  const { rows } = await client.query<WorkspaceUsage & { start: Date; end: Date }>(
    `WITH spans AS (${spans}),
     opening AS (
       SELECT coalesce(sum(byte_delta), 0) AS bytes, coalesce(sum(ingested_tokens), 0) AS tokens
       FROM workspace_content_usage WHERE workspace_id = $1 AND at < $2
     ), balances AS (
       SELECT spans.*, ops.*, content.*,
              opening.bytes + sum(content.delta) OVER chronological AS bytes,
              opening.tokens + sum(content.tokens) OVER chronological AS lifetime
       FROM spans CROSS JOIN opening
       CROSS JOIN LATERAL (
         SELECT count(*) FILTER (WHERE kind = 'query')::float8 AS queries,
                count(*) FILTER (WHERE kind = 'reply')::float8 AS replies
         FROM workspace_operations WHERE workspace_id = $1 AND at >= lo AND at < hi
       ) ops
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(ingested_tokens), 0) AS tokens, coalesce(sum(byte_delta), 0) AS delta,
                coalesce(sum(byte_delta * extract(epoch FROM (at - lo))), 0) AS offset_byte_seconds
         FROM workspace_content_usage WHERE workspace_id = $1 AND at >= lo AND at < hi
       ) content
       WINDOW chronological AS (ORDER BY lo)
     )
     SELECT lo AS start, hi AS end, queries, replies, tokens::float8 AS "ingestedTokens",
            lifetime::float8 AS "lifetimeIngestedTokens", bytes::float8 AS "storedBytes",
            (bytes * extract(epoch FROM (hi - lo)) - offset_byte_seconds)::text AS "storageByteSeconds"
     FROM balances ORDER BY lo`,
    params,
  );
  return rows.map(({ start, end, ...usage }) => ({
    ...usage,
    start: start.toISOString(),
    end: end.toISOString(),
  }));
}

export async function readWorkspaceUsage(
  client: PoolClient,
  workspaceId: string,
  window: UsageWindow,
) {
  const [usage] = await readWorkspaceUsageBuckets(client, workspaceId, window);
  if (!usage) throw new Error("Workspace usage aggregation returned no row.");
  return { workspaceId, ...usage };
}
