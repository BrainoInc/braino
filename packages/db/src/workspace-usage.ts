import type { PoolClient } from "pg";
import type { CommitSource } from "./history.js";

/** Call inside the authenticated write transaction so triggers see the same actor
 * and the connection releases their identity on commit or rollback. */
export async function setWorkspaceUsageActor(client: PoolClient, userId: string): Promise<void> {
  await client.query("SELECT set_config('braino.usage_user_id', $1, true)", [userId]);
}

/** Record the same query event consumed by activity reports, Times and usage.
 * Searches in Open run against records; its corpus snapshot uses the same
 * collection token counts as Hosted briefs and searches. */
export async function recordQueryEvent(
  client: PoolClient,
  event: {
    workspaceId: string;
    collectionId?: string | null;
    actor: string | null;
    source: CommitSource;
    metadata?: Record<string, unknown> | null;
    searchedRecords?: boolean;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO query_events (workspace_id,collection_id,actor,source,metadata)
    VALUES ($1,$2,$3,$4,CASE WHEN $6::boolean THEN coalesce($5::jsonb,'{}') || jsonb_build_object(
      'searched_tokens',(SELECT coalesce(sum(t.tokens),0) FROM collection_tokens t
          JOIN collections c ON c.id=t.collection_id WHERE c.workspace_id=$1 AND c.deleted_at IS NULL AND t.source='records'))
      ELSE $5::jsonb END)`,
    [
      event.workspaceId,
      event.collectionId ?? null,
      event.actor,
      event.source,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.searchedRecords ?? false,
    ],
  );
}

/** Use a stable server-side operation identity when a completion can be replayed. */
export async function recordWorkspaceReply(
  client: PoolClient,
  workspaceId: string,
  operationId: string,
  userId: string | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_operations (workspace_id, kind, operation_id, user_id)
     VALUES ($1, 'reply', $2, (SELECT user_id FROM workspace_users WHERE workspace_id=$1 AND user_id=$3)) ON CONFLICT DO NOTHING`,
    [workspaceId, operationId, userId],
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
  searchedTokens: number;
  writes: number;
  imports: number;
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
  memberId: string | null = null,
) {
  const params = [workspaceId, start.toISOString(), end.toISOString(), memberId];
  const spans = step
    ? `SELECT tick AS lo, least(tick + $5::interval, $3::timestamptz) AS hi
         FROM generate_series($2::timestamptz, $3::timestamptz, $5::interval) tick
        WHERE tick < $3 OR tick = $2`
    : "SELECT $2::timestamptz AS lo, $3::timestamptz AS hi";
  if (step) params.push(step);
  const { rows } = await client.query<WorkspaceUsage & { start: Date; end: Date }>(
    `WITH spans AS (${spans}),
     opening AS (
       SELECT coalesce(sum(byte_delta), 0) AS bytes, coalesce(sum(ingested_tokens) FILTER (WHERE $4::text IS NULL OR user_id = $4), 0) AS tokens
       FROM workspace_content_usage WHERE workspace_id = $1 AND at < $2
     ), balances AS (
       SELECT spans.*, q.*, w.*, i.*, ops.*, content.*,
              opening.bytes + sum(content.delta) OVER chronological AS bytes,
              opening.tokens + sum(content.tokens) OVER chronological AS lifetime
       FROM spans CROSS JOIN opening
       CROSS JOIN LATERAL (
         SELECT count(*)::float8 AS queries, coalesce(sum((metadata->>'searched_tokens')::bigint),0)::float8 AS "searchedTokens"
         FROM query_events WHERE workspace_id=$1 AND at>=lo AND at<hi AND ($4::text IS NULL OR actor=$4)
       ) q
       CROSS JOIN LATERAL (
         SELECT count(*)::float8 AS writes FROM activity_writes e JOIN collections c ON c.id=e.collection_id
         WHERE c.workspace_id=$1 AND e.at>=lo AND e.at<hi AND ($4::text IS NULL OR e.actor=$4)
       ) w
       CROSS JOIN LATERAL (
         SELECT count(*)::float8 AS imports FROM imported_items e JOIN collections c ON c.id=e.collection_id
         WHERE c.workspace_id=$1 AND e.at>=lo AND e.at<hi
       ) i
       CROSS JOIN LATERAL (
         SELECT count(*)::float8 AS replies
         FROM workspace_operations WHERE kind = 'reply' AND workspace_id = $1 AND at >= lo AND at < hi
           AND ($4::text IS NULL OR user_id = $4)
       ) ops
       CROSS JOIN LATERAL (
         SELECT coalesce(sum(ingested_tokens) FILTER (WHERE $4::text IS NULL OR user_id = $4), 0) AS tokens, coalesce(sum(byte_delta), 0) AS delta,
                coalesce(sum(byte_delta * extract(epoch FROM (at - lo))), 0) AS offset_byte_seconds
         FROM workspace_content_usage WHERE workspace_id = $1 AND at >= lo AND at < hi
       ) content
       WINDOW chronological AS (ORDER BY lo)
     )
     SELECT lo AS start, hi AS end, queries, "searchedTokens", writes, imports, replies, tokens::float8 AS "ingestedTokens",
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
  memberId: string | null = null,
) {
  const [usage] = await readWorkspaceUsageBuckets(client, workspaceId, window, undefined, memberId);
  if (!usage) throw new Error("Workspace usage aggregation returned no row.");
  return { workspaceId, ...(memberId ? { memberId } : {}), ...usage };
}
