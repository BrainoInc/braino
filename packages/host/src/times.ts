import type { PoolClient } from "@braino/db";
import type {
  EmailMessage,
  EmailSendResponse,
  TeamChatMessage,
  TeamChatSendResponse,
} from "@braino/plugin-runtime";

export const DEFAULT_TIMES_TIME_ZONE = "America/Los_Angeles";
export const TIMES_STORY_LIMIT = 15;

export interface TimesCandidate {
  id: string;
  collectionId: string;
  collectionHandle: string;
  nodeType: string;
  prose: string;
  createdAt: string;
  links: number;
  served: number;
  replaces: boolean;
}

export interface TimesStory {
  id: string;
  collectionId: string;
  collectionHandle: string;
  nodeType: string;
  headline: string;
  takeaway: string;
  url: string;
}

export interface TimesEdition {
  day: string;
  title: string;
  publishedAt: string;
  stories: TimesStory[];
}

export type TimesEditionRead =
  | { kind: "hidden" }
  | { kind: "missing" }
  | ({ kind: "edition"; public: boolean } & TimesEdition);

export interface TimesEmailTransport {
  send(input: EmailMessage): Promise<EmailSendResponse>;
}

export interface TimesTeamChatTransport {
  installation: { installationId: string };
  send(input: TeamChatMessage): Promise<TeamChatSendResponse>;
}

const TYPE_POINTS: Record<string, number> = { rule: 3, decision: 2 };

function datePart(at: Date, timeZone: string, type: "year" | "month" | "day"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function editionDay(at: Date, timeZone: string): string {
  return [
    datePart(at, timeZone, "year"),
    datePart(at, timeZone, "month"),
    datePart(at, timeZone, "day"),
  ].join("-");
}

function headline(prose: string): string {
  const first = prose
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#+\s*/, "");
  if (!first) return "Untitled record";
  return first.length > 120 ? `${first.slice(0, 119)}…` : first;
}

function score(candidate: TimesCandidate): number {
  return (
    (TYPE_POINTS[candidate.nodeType] ?? 1) +
    (candidate.replaces ? 2 : 0) +
    Math.log2(1 + candidate.served) +
    Math.log2(1 + candidate.links)
  );
}

export function rankTimesCandidates(candidates: TimesCandidate[], baseUrl = ""): TimesStory[] {
  const base = baseUrl.replace(/\/+$/, "");
  return candidates
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.createdAt.localeCompare(left.candidate.createdAt) ||
        left.candidate.id.localeCompare(right.candidate.id),
    )
    .slice(0, TIMES_STORY_LIMIT)
    .map(({ candidate }) => ({
      id: candidate.id,
      collectionId: candidate.collectionId,
      collectionHandle: candidate.collectionHandle,
      nodeType: candidate.nodeType,
      headline: headline(candidate.prose),
      takeaway: "",
      url: `${base}/${candidate.collectionHandle}/${candidate.id}`,
    }));
}

async function loadCandidates(
  client: PoolClient,
  workspaceId: string,
  at: Date,
): Promise<TimesCandidate[]> {
  const since = new Date(at.getTime() - 24 * 60 * 60 * 1_000);
  const result = await client.query<{
    id: string;
    collection_id: string;
    collection_handle: string;
    node_type: string;
    prose: string;
    created_at: Date | string;
    links: number;
    served: number;
    replaces: boolean;
  }>(
    `WITH served AS (
       SELECT item->>'id' AS id, count(*)::int AS count
         FROM query_events q
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(q.metadata->'served') = 'array'
               THEN q.metadata->'served' ELSE '[]'::jsonb END
        ) item
        WHERE q.workspace_id = $1 AND q.at >= $2 AND q.at < $3
        GROUP BY item->>'id'
     )
     SELECT n.id, n.collection_id, c.handle AS collection_handle,
            n.node_type, n.prose, n.created_at,
            (SELECT count(*)::int FROM edges e
              WHERE (e.from_id = n.id OR e.to_id = n.id)
                AND e.edge_type <> 'attributed_to' AND e.lifecycle <> 'retired') AS links,
            coalesce(s.count, 0) AS served,
            EXISTS (
              SELECT 1 FROM edges e
               WHERE e.from_id = n.id AND e.edge_type = 'replaces'
                 AND e.lifecycle <> 'retired'
            ) AS replaces
       FROM nodes n
       JOIN collections c ON c.id = n.collection_id
       LEFT JOIN served s ON s.id = n.id
      WHERE c.workspace_id = $1 AND c.deleted_at IS NULL
        AND n.lifecycle <> 'retired' AND n.node_type NOT IN ('log', 'principal')
        AND n.created_at >= $2 AND n.created_at < $3
      ORDER BY n.created_at DESC, n.id`,
    [workspaceId, since.toISOString(), at.toISOString()],
  );
  return result.rows.map((row) => ({
    id: row.id,
    collectionId: row.collection_id,
    collectionHandle: row.collection_handle,
    nodeType: row.node_type,
    prose: row.prose,
    createdAt: new Date(row.created_at).toISOString(),
    links: row.links,
    served: row.served,
    replaces: row.replaces,
  }));
}

export async function publishTimesEdition(
  client: PoolClient,
  input: { workspaceId: string; at: Date; baseUrl: string },
): Promise<TimesEdition | null> {
  const workspace = await client.query<{
    name: string;
    times_timezone: string;
  }>("SELECT name, times_timezone FROM workspaces WHERE id = $1", [input.workspaceId]);
  const row = workspace.rows[0];
  if (!row) return null;
  const day = editionDay(input.at, row.times_timezone);
  const claimed = await client.query(
    `INSERT INTO times_editions
       (workspace_id, cadence, edition_day, published_at, stories)
     VALUES ($1, 'daily', $2::date, $3, '[]'::jsonb)
     ON CONFLICT (workspace_id, cadence, edition_day) DO NOTHING
     RETURNING edition_day`,
    [input.workspaceId, day, input.at.toISOString()],
  );
  if (claimed.rows.length === 0) return null;
  try {
    const stories = rankTimesCandidates(
      await loadCandidates(client, input.workspaceId, input.at),
      input.baseUrl,
    );
    await client.query(
      `UPDATE times_editions SET stories = $4::jsonb
        WHERE workspace_id = $1 AND cadence = 'daily' AND edition_day = $2::date
          AND published_at = $3`,
      [input.workspaceId, day, input.at.toISOString(), JSON.stringify(stories)],
    );
    return {
      day,
      title: `The ${row.name} Times`,
      publishedAt: input.at.toISOString(),
      stories,
    };
  } catch (error) {
    await client.query(
      `DELETE FROM times_editions
        WHERE workspace_id = $1 AND cadence = 'daily' AND edition_day = $2::date
          AND published_at = $3`,
      [input.workspaceId, day, input.at.toISOString()],
    );
    throw error;
  }
}

export async function publishDueTimesEdition(
  client: PoolClient,
  input: { workspaceId: string; at: Date; baseUrl: string },
): Promise<TimesEdition | null> {
  const workspace = await client.query<{
    created_at: Date | string;
    times_timezone: string;
  }>("SELECT created_at, times_timezone FROM workspaces WHERE id = $1", [input.workspaceId]);
  const row = workspace.rows[0];
  if (!row) return null;
  const today = editionDay(input.at, row.times_timezone);
  const createdDay = editionDay(new Date(row.created_at), row.times_timezone);
  const localHour = new Intl.DateTimeFormat("en", {
    timeZone: row.times_timezone,
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(input.at)
    .find((part) => part.type === "hour")?.value;
  if (createdDay === today && localHour !== "00") return null;
  return publishTimesEdition(client, input);
}

function cadenceDue(cadence: string, at: Date, timeZone: string): boolean {
  if (cadence === "daily") return true;
  if (cadence !== "weekly") return false;
  return new Intl.DateTimeFormat("en", { timeZone, weekday: "short" }).format(at) === "Mon";
}

function timesUrl(baseUrl: string, day: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/times/${day}`;
}

function editionMessage(edition: TimesEdition, baseUrl: string): string {
  const stories = edition.stories.length
    ? edition.stories.map((story) => `• ${story.headline}\n${story.url}`).join("\n\n")
    : "";
  return [edition.title, edition.day, stories, timesUrl(baseUrl, edition.day)]
    .filter(Boolean)
    .join("\n\n");
}

async function claimDelivery(
  client: PoolClient,
  input: {
    workspaceId: string;
    day: string;
    transport: "email" | "team_chat";
    recipient: string;
    at: Date;
  },
): Promise<boolean> {
  const claimed = await client.query(
    `INSERT INTO times_deliveries
       (workspace_id, cadence, edition_day, transport, recipient, attempts, attempted_at)
     VALUES ($1, 'daily', $2::date, $3, $4, 1, $5)
     ON CONFLICT (workspace_id, cadence, edition_day, transport, recipient)
     DO UPDATE SET attempts = times_deliveries.attempts + 1,
                   attempted_at = EXCLUDED.attempted_at,
                   last_error = NULL
       WHERE times_deliveries.delivered_at IS NULL
         AND (times_deliveries.attempted_at IS NULL
              OR times_deliveries.attempted_at <= EXCLUDED.attempted_at - interval '5 minutes')
     RETURNING recipient`,
    [input.workspaceId, input.day, input.transport, input.recipient, input.at.toISOString()],
  );
  return claimed.rows.length > 0;
}

async function finishDelivery(
  client: PoolClient,
  input: {
    workspaceId: string;
    day: string;
    transport: "email" | "team_chat";
    recipient: string;
    at: Date;
    externalId?: string;
    failed?: boolean;
  },
): Promise<void> {
  await client.query(
    `UPDATE times_deliveries
        SET delivered_at = CASE WHEN $6::boolean THEN NULL ELSE $5::timestamptz END,
            external_id = CASE WHEN $6::boolean THEN NULL ELSE $7::text END,
            last_error = CASE WHEN $6::boolean THEN 'delivery_failed' ELSE NULL END
      WHERE workspace_id = $1 AND cadence = 'daily' AND edition_day = $2::date
        AND transport = $3 AND recipient = $4`,
    [
      input.workspaceId,
      input.day,
      input.transport,
      input.recipient,
      input.at.toISOString(),
      input.failed ?? false,
      input.externalId ?? null,
    ],
  );
}

/** Deliver today's already-published edition through the workspace's installed
 * transports. Successful destinations are idempotent across scheduler ticks;
 * failed ones become retryable after five minutes. */
export async function deliverDueTimesEdition(
  client: PoolClient,
  input: {
    workspaceId: string;
    at: Date;
    baseUrl: string;
    email: TimesEmailTransport | null;
    teamChat: TimesTeamChatTransport | null;
  },
): Promise<{ delivered: number; failed: number }> {
  const workspace = await client.query<{ name: string; times_timezone: string }>(
    "SELECT name, times_timezone FROM workspaces WHERE id = $1",
    [input.workspaceId],
  );
  const workspaceRow = workspace.rows[0];
  if (!workspaceRow) return { delivered: 0, failed: 0 };
  const day = editionDay(input.at, workspaceRow.times_timezone);
  const found = await client.query<{ published_at: Date | string; stories: TimesStory[] }>(
    `SELECT published_at, stories
       FROM times_editions
      WHERE workspace_id = $1 AND cadence = 'daily' AND edition_day = $2::date`,
    [input.workspaceId, day],
  );
  const row = found.rows[0];
  if (!row) return { delivered: 0, failed: 0 };
  const edition: TimesEdition = {
    day,
    title: `The ${workspaceRow.name} Times`,
    publishedAt: new Date(row.published_at).toISOString(),
    stories: row.stories,
  };
  const message = editionMessage(edition, input.baseUrl);
  let delivered = 0;
  let failed = 0;

  if (input.email) {
    const members = await client.query<{ user_id: string; email: string; digest: string }>(
      `SELECT u.id AS user_id, u.email, wu.digest
         FROM workspace_users wu
         JOIN users u ON u.id = wu.user_id
        WHERE wu.workspace_id = $1 AND u.deactivated_at IS NULL
          AND coalesce(u.email, '') <> '' AND wu.digest <> 'off'
        ORDER BY u.id`,
      [input.workspaceId],
    );
    for (const member of members.rows) {
      if (!cadenceDue(member.digest, input.at, workspaceRow.times_timezone)) continue;
      if (
        !(await claimDelivery(client, {
          workspaceId: input.workspaceId,
          day,
          transport: "email",
          recipient: member.user_id,
          at: input.at,
        }))
      )
        continue;
      try {
        const receipt = await input.email.send({
          to: [member.email],
          subject: `${edition.title} · ${edition.day}`,
          text: message,
        });
        await finishDelivery(client, {
          workspaceId: input.workspaceId,
          day,
          transport: "email",
          recipient: member.user_id,
          at: input.at,
          externalId: receipt.externalId,
        });
        delivered += 1;
      } catch {
        await finishDelivery(client, {
          workspaceId: input.workspaceId,
          day,
          transport: "email",
          recipient: member.user_id,
          at: input.at,
          failed: true,
        });
        failed += 1;
      }
    }
  }

  if (input.teamChat) {
    const setting = await client.query<{ default_channel_id: string | null; digest: string }>(
      `SELECT default_channel_id, digest
         FROM group_chat_installations
        WHERE provider = 'slack' AND braino_workspace_id = $1
        ORDER BY updated_at DESC LIMIT 1`,
      [input.workspaceId],
    );
    const configured = setting.rows[0];
    let target = configured?.default_channel_id ?? null;
    if (!target) {
      const direct = await client.query<{ channel_id: string }>(
        `SELECT data->>'channelId' AS channel_id
           FROM plugin_event_deliveries
          WHERE workspace_id = $1 AND installation_id = $2
            AND kind = 'team_chat.message' AND data->>'direct' = 'true'
            AND coalesce(data->>'channelId', '') <> ''
          ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [input.workspaceId, input.teamChat.installation.installationId],
      );
      target = direct.rows[0]?.channel_id ?? null;
    }
    const digest = configured?.digest ?? "daily";
    if (target && cadenceDue(digest, input.at, workspaceRow.times_timezone)) {
      if (
        await claimDelivery(client, {
          workspaceId: input.workspaceId,
          day,
          transport: "team_chat",
          recipient: target,
          at: input.at,
        })
      ) {
        try {
          const receipt = await input.teamChat.send({
            target: { kind: "channel", id: target },
            text: message,
          });
          await finishDelivery(client, {
            workspaceId: input.workspaceId,
            day,
            transport: "team_chat",
            recipient: target,
            at: input.at,
            externalId: receipt.externalId,
          });
          delivered += 1;
        } catch {
          await finishDelivery(client, {
            workspaceId: input.workspaceId,
            day,
            transport: "team_chat",
            recipient: target,
            at: input.at,
            failed: true,
          });
          failed += 1;
        }
      }
    }
  }

  return { delivered, failed };
}

export async function latestTimesEditionDay(
  client: PoolClient,
  workspaceId: string,
): Promise<string | null> {
  const result = await client.query<{ day: string | Date | null }>(
    `SELECT max(edition_day)::text AS day FROM times_editions
      WHERE workspace_id = $1 AND cadence = 'daily'`,
    [workspaceId],
  );
  return result.rows[0]?.day ? String(result.rows[0].day) : null;
}

export async function loadTimesEdition(
  client: PoolClient,
  input: { workspaceId: string; day: string; userId: string | null },
): Promise<TimesEditionRead> {
  const workspace = await client.query<{ name: string; times_public: boolean }>(
    "SELECT name, times_public FROM workspaces WHERE id = $1",
    [input.workspaceId],
  );
  const workspaceRow = workspace.rows[0];
  if (!workspaceRow) return { kind: "missing" };
  const member = input.userId
    ? (
        await client.query(
          "SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
          [input.workspaceId, input.userId],
        )
      ).rows.length > 0
    : false;
  if (!member && !workspaceRow.times_public) return { kind: "hidden" };
  const edition = await client.query<{
    edition_day: string | Date;
    published_at: Date | string;
    stories: TimesStory[];
  }>(
    `SELECT edition_day, published_at, stories
       FROM times_editions
      WHERE workspace_id = $1 AND cadence = 'daily' AND edition_day = $2::date`,
    [input.workspaceId, input.day],
  );
  const editionRow = edition.rows[0];
  if (!editionRow) return { kind: "missing" };
  let stories = editionRow.stories;
  if (!member) {
    const publicCollections = await client.query<{ id: string }>(
      `SELECT id FROM collections
        WHERE workspace_id = $1 AND visibility = 'public' AND deleted_at IS NULL`,
      [input.workspaceId],
    );
    const allowed = new Set(publicCollections.rows.map((collection) => collection.id));
    stories = stories.filter((story) => allowed.has(story.collectionId));
  }
  return {
    kind: "edition",
    public: !member,
    day: String(editionRow.edition_day),
    title: `The ${workspaceRow.name} Times`,
    publishedAt: new Date(editionRow.published_at).toISOString(),
    stories,
  };
}
