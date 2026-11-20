import { describe, expect, it } from "vitest";
import { loadOrbitActivity, loadOrbitLinks, sizeCollections } from "../orbit.server";

function client() {
  return {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      if (sql.includes("FROM collections c")) {
        return {
          rows: [
            {
              id: "collection_chat",
              handle: "meta-chat",
              template: "agents-chats",
              visibility: "private",
              items: 12,
            },
          ] as T[],
        };
      }
      if (sql.includes("COUNT(*)::int AS n") && sql.includes("FROM edges e")) {
        return {
          rows: [
            {
              from_collection: "collection_chat",
              to_collection: "collection_chat",
              n: 3,
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM changesets")) {
        return {
          rows: [
            {
              slice: 1,
              collection_id: "collection_chat",
              actor: "user_owner",
              source: "mcp:codex",
              n: 2,
              first_at: "2026-11-20T00:00:00.000Z",
              last_at: "2026-11-20T00:01:00.000Z",
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM query_events")) return { rows: [] };
      if (sql.includes("FROM imported_items")) {
        return {
          rows: [
            {
              slice: 2,
              collection_id: "collection_chat",
              actor: null,
              source: "slack",
              n: 4,
              first_at: "2026-11-20T00:02:00.000Z",
              last_at: "2026-11-20T00:03:00.000Z",
            },
          ] as T[],
        };
      }
      if (sql.includes("FROM users")) {
        return {
          rows: [{ id: "user_owner", username: "owner", name: "Owner" }] as T[],
        };
      }
      if (sql.includes("MAX(e.created_at) AS at")) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

describe("Open Braino workspace Orbit", () => {
  it("draws collections, relationships, people, agents and integrations from workspace data", async () => {
    const db = client();
    const collections = await sizeCollections(db, "workspace_meta");
    const links = await loadOrbitLinks(db, collections);
    const activity = await loadOrbitActivity(db, {
      collections,
      workspaceId: "workspace_meta",
      range: "7d",
      now: new Date("2026-11-20T01:00:00.000Z"),
    });

    expect(collections).toEqual([
      expect.objectContaining({ handle: "meta-chat", items: 12, visibility: "private" }),
    ]);
    expect(links).toEqual([[0, 0, 3]]);
    expect(activity.collections[0]).toMatchObject({ activity: [4, 2, 0] });
    expect(activity.actors.map((actor) => actor.name)).toEqual(
      expect.arrayContaining(["Slack", "Owner", "Codex"]),
    );
    expect(activity.events).toHaveLength(2);
    expect(activity.buckets[0][2]).toBe(4);
    expect(activity.buckets[1][1]).toBe(2);
  });
});
