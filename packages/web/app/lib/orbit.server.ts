import {
  ORBIT_BUCKETS,
  ORBIT_LOGS,
  ORBIT_RANGES,
  type OrbitActivity,
  type OrbitActor,
  type OrbitEvent,
  type OrbitLinks,
  type OrbitRange,
} from "./orbit";

type QueryClient = { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> };

export interface SizedCollection {
  id: string;
  handle: string;
  template: string | null;
  visibility: "public" | "private";
  items: number;
}

export async function sizeCollections(
  client: QueryClient,
  workspaceId: string,
): Promise<SizedCollection[]> {
  const result = await client.query<{
    id: string;
    handle: string;
    template: string | null;
    visibility: "public" | "private";
    items: number;
  }>(
    `SELECT c.id, c.handle, NULLIF(c.data->>'template_handle', '') AS template,
            c.visibility, COUNT(n.id)::int AS items
       FROM collections c
       LEFT JOIN nodes n ON n.collection_id = c.id AND n.lifecycle <> 'retired'
      WHERE c.workspace_id = $1 AND c.deleted_at IS NULL
      GROUP BY c.id, c.handle, c.data, c.visibility
      ORDER BY items DESC, c.handle`,
    [workspaceId],
  );
  return result.rows;
}

function orderedPair(index: Map<string, number>, from: string, to: string): [number, number] {
  const a = index.get(from) ?? -1;
  const b = index.get(to) ?? -1;
  return a <= b ? [a, b] : [b, a];
}

export async function loadOrbitLinks(
  client: QueryClient,
  collections: readonly SizedCollection[],
): Promise<OrbitLinks> {
  if (collections.length === 0) return [];
  const ids = collections.map((collection) => collection.id);
  const index = new Map(ids.map((id, place) => [id, place]));
  const result = await client.query<{ from_collection: string; to_collection: string; n: number }>(
    `SELECT f.collection_id AS from_collection, t.collection_id AS to_collection,
            COUNT(*)::int AS n
       FROM edges e
       JOIN nodes f ON f.id = e.from_id
       JOIN nodes t ON t.id = e.to_id
      WHERE e.collection_id = ANY($1::text[]) AND e.lifecycle <> 'retired'
        AND f.collection_id = ANY($1::text[]) AND t.collection_id = ANY($1::text[])
      GROUP BY f.collection_id, t.collection_id`,
    [ids],
  );
  const links = new Map<string, [number, number, number]>();
  for (const row of result.rows) {
    const [a, b] = orderedPair(index, row.from_collection, row.to_collection);
    const key = `${a}:${b}`;
    const prior = links.get(key);
    if (prior) prior[2] += row.n;
    else links.set(key, [a, b, row.n]);
  }
  return [...links.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

type ActivityRow = {
  log: (typeof ORBIT_LOGS)[number];
  slice: number;
  collection_id: string | null;
  actor: string | null;
  source: string;
  n: number;
  first_at: string | Date;
  last_at: string | Date;
};

const INTEGRATION_LOGOS = new Map<string, OrbitActor["logo"]>([
  ["slack", "slack"],
  ["github", "github"],
  ["notion", "notion"],
  ["google-drive", "google-drive"],
  ["google_drive", "google-drive"],
]);

function displaySource(source: string): string {
  return source
    .replace(/^mcp:/, "")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export async function loadOrbitActivity(
  client: QueryClient,
  options: {
    collections: readonly SizedCollection[];
    workspaceId: string;
    range: OrbitRange;
    now?: Date;
  },
): Promise<OrbitActivity> {
  const until = options.now ?? new Date();
  const since = new Date(until.getTime() - ORBIT_RANGES[options.range]);
  const period = { since: since.toISOString(), until: until.toISOString() };
  const ids = options.collections.map((collection) => collection.id);
  const index = new Map(ids.map((id, place) => [id, place]));
  const sliceSeconds = ORBIT_RANGES[options.range] / ORBIT_BUCKETS / 1000;
  const rows: ActivityRow[] = [];

  if (ids.length > 0) {
    const queries: Array<{ log: ActivityRow["log"]; sql: string; params: unknown[] }> = [
      {
        log: "writes",
        sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (recorded_at - $2::timestamptz)) / $4)::int AS slice,
                     collection_id, actor, source, COUNT(*)::int AS n,
                     MIN(recorded_at) AS first_at, MAX(recorded_at) AS last_at
                FROM changesets
               WHERE collection_id = ANY($1::text[]) AND recorded_at >= $2 AND recorded_at < $3
               GROUP BY slice, collection_id, actor, source`,
        params: [ids, period.since, period.until, sliceSeconds],
      },
      {
        log: "queries",
        sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (at - $3::timestamptz)) / $5)::int AS slice,
                     collection_id, actor, source, COUNT(*)::int AS n,
                     MIN(at) AS first_at, MAX(at) AS last_at
                FROM query_events
               WHERE (collection_id = ANY($1::text[]) OR (collection_id IS NULL AND workspace_id = $2))
                 AND at >= $3 AND at < $4
               GROUP BY slice, collection_id, actor, source`,
        params: [ids, options.workspaceId, period.since, period.until, sliceSeconds],
      },
      {
        log: "imports",
        sql: `SELECT FLOOR(EXTRACT(EPOCH FROM (at - $2::timestamptz)) / $4)::int AS slice,
                     collection_id, NULL::text AS actor, integration AS source,
                     COUNT(*)::int AS n, MIN(at) AS first_at, MAX(at) AS last_at
                FROM imported_items
               WHERE collection_id = ANY($1::text[]) AND at >= $2 AND at < $3
               GROUP BY slice, collection_id, integration`,
        params: [ids, period.since, period.until, sliceSeconds],
      },
    ];
    for (const query of queries) {
      const result = await client.query<Omit<ActivityRow, "log">>(query.sql, query.params);
      rows.push(...result.rows.map((row) => ({ ...row, log: query.log })));
    }
  }

  const peopleResult = await client.query<{ id: string; username: string; name: string | null }>(
    `SELECT id, COALESCE(username, id) AS username, name
       FROM users
      WHERE id = ANY($1::text[])`,
    [[...new Set(rows.flatMap((row) => (row.actor ? [row.actor] : [])))]],
  );
  const people = new Map(
    peopleResult.rows.map((person) => [person.id, person.name?.trim() || person.username]),
  );

  type PendingActor = Omit<OrbitActor, "owner"> & { key: string; ownerKey: string | null };
  const actors = new Map<string, PendingActor>();
  const actorFor = (row: ActivityRow): string | null => {
    if (row.log === "imports") {
      const key = `integration:${row.source}`;
      const seen = actors.get(key);
      if (seen) seen.count += row.n;
      else
        actors.set(key, {
          key,
          ownerKey: null,
          kind: "integration",
          name: displaySource(row.source),
          count: row.n,
          into: row.collection_id ? (index.get(row.collection_id) ?? -1) : -1,
          logo: INTEGRATION_LOGOS.get(row.source) ?? null,
        });
      return key;
    }
    if (!row.actor || !people.has(row.actor)) return null;
    const personKey = `person:${row.actor}`;
    const person = actors.get(personKey);
    if (person) person.count += row.n;
    else
      actors.set(personKey, {
        key: personKey,
        ownerKey: null,
        kind: "person",
        name: people.get(row.actor) ?? row.actor,
        count: row.n,
        into: row.collection_id ? (index.get(row.collection_id) ?? -1) : -1,
        logo: null,
      });
    const website = row.source === "web" || row.source === "website" || row.source === "ui";
    if (website) return personKey;
    const agentKey = `agent:${row.actor}:${row.source}`;
    const agent = actors.get(agentKey);
    if (agent) agent.count += row.n;
    else
      actors.set(agentKey, {
        key: agentKey,
        ownerKey: personKey,
        kind: "agent",
        name: displaySource(row.source),
        count: row.n,
        into: row.collection_id ? (index.get(row.collection_id) ?? -1) : -1,
        logo: "agent",
      });
    return agentKey;
  };

  const buckets: OrbitActivity["buckets"] = [
    new Array(ORBIT_BUCKETS).fill(0),
    new Array(ORBIT_BUCKETS).fill(0),
    new Array(ORBIT_BUCKETS).fill(0),
  ];
  const collections = options.collections.map((collection) => ({
    handle: collection.handle,
    template: collection.template,
    visibility: collection.visibility,
    items: collection.items,
    activity: [0, 0, 0] as [number, number, number],
  }));
  const pendingEvents: Array<{ row: ActivityRow; actorKey: string }> = [];
  for (const row of rows) {
    const log = ORBIT_LOGS.indexOf(row.log);
    const slice = Math.max(0, Math.min(ORBIT_BUCKETS - 1, Number(row.slice)));
    buckets[log][slice] += Number(row.n);
    const collection = row.collection_id ? (index.get(row.collection_id) ?? -1) : -1;
    if (collection >= 0) collections[collection].activity[log] += Number(row.n);
    const actorKey = actorFor(row);
    if (actorKey) pendingEvents.push({ row, actorKey });
  }

  const ranked = [...actors.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );
  const actorIndex = new Map(ranked.map((actor, place) => [actor.key, place]));
  const orbitActors: OrbitActor[] = ranked.map((actor) => ({
    kind: actor.kind,
    name: actor.name,
    count: actor.count,
    into: actor.into,
    logo: actor.logo,
    owner: actor.ownerKey ? (actorIndex.get(actor.ownerKey) ?? -1) : -1,
  }));
  const events: OrbitEvent[] = pendingEvents
    .map(
      ({ row, actorKey }): OrbitEvent => [
        Date.parse(String(row.last_at)),
        ORBIT_LOGS.indexOf(row.log),
        actorIndex.get(actorKey) ?? 0,
        row.collection_id ? (index.get(row.collection_id) ?? -1) : -1,
        Number(row.n),
      ],
    )
    .sort((a, b) => a[0] - b[0]);

  const newLinksResult =
    ids.length === 0
      ? {
          rows: [] as Array<{
            at: string | Date;
            from_collection: string;
            to_collection: string;
            n: number;
          }>,
        }
      : await client.query<{
          at: string | Date;
          from_collection: string;
          to_collection: string;
          n: number;
        }>(
          `SELECT MAX(e.created_at) AS at, f.collection_id AS from_collection,
                  t.collection_id AS to_collection, COUNT(*)::int AS n
             FROM edges e
             JOIN nodes f ON f.id = e.from_id
             JOIN nodes t ON t.id = e.to_id
            WHERE e.collection_id = ANY($1::text[]) AND e.lifecycle <> 'retired'
              AND e.created_at >= $2 AND e.created_at < $3
            GROUP BY f.collection_id, t.collection_id`,
          [ids, period.since, period.until],
        );
  const newLinks: OrbitActivity["newLinks"] = newLinksResult.rows
    .map((row) => {
      const [a, b] = orderedPair(index, row.from_collection, row.to_collection);
      return [Date.parse(String(row.at)), a, b, Number(row.n)] as [number, number, number, number];
    })
    .sort((a, b) => a[0] - b[0]);

  return { ...period, collections, newLinks, actors: orbitActors, events, buckets };
}
