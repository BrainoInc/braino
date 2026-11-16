import type { PoolClient } from "@doco/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  connectGithubRepository,
  connectGithubRepositoryWithPlugin,
  deliverGithubGatewayWebhook,
  finishGithubGatewayMigration,
} from "../github-connections.js";
import type { PluginGithubProvider } from "../plugin-github.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const scope = <T>(operation: (client: PoolClient) => Promise<T>) => operation(client());
const encryptionKey = "github-gateway-webhook-key-with-more-than-thirty-two-characters";

async function fixture() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

function githubForConnection(): typeof fetch {
  return (async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "https://api.github.com/repos/acme/widgets") {
      return Response.json({ full_name: "acme/widgets", default_branch: "main" });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function gatewayPlugin(input: {
  workspaceId: string;
  ownerId: string;
  commitMessages: string[];
  publishCheck: ReturnType<typeof vi.fn>;
}): Promise<PluginGithubProvider> {
  const digest = `sha256:${"1".repeat(64)}`;
  await db.query("INSERT INTO plugin_artifacts (digest, component) VALUES ($1, $2)", [
    digest,
    new Uint8Array([1]),
  ]);
  await db.query(
    `INSERT INTO plugin_installations
       (id, workspace_id, manifest, artifact_digest, configuration,
        created_by_user_id, updated_by_user_id)
     VALUES ('plugin_installation_github', $1, $2::jsonb, $3, '{}'::jsonb, $4, $4)`,
    [input.workspaceId, JSON.stringify({ id: "braino.github" }), digest, input.ownerId],
  );
  return {
    installation: {
      workspaceId: input.workspaceId,
      installationId: "plugin_installation_github",
      pluginId: "braino.github",
    },
    repositories: async () => [{ fullName: "acme/widgets", defaultBranch: "main" }],
    request: async ({ path }: { path: string }) => {
      if (path === "/repos/acme/widgets") {
        return { data: { full_name: "acme/widgets", default_branch: "main" }, next: null };
      }
      if (path.includes("/issues?") || path.includes("/pulls?")) {
        return { data: [], next: null };
      }
      if (path === "/repos/acme/widgets/git/trees/main?recursive=1") {
        return { data: { truncated: false, tree: [] }, next: null };
      }
      throw new Error(`Unexpected GitHub plugin path: ${path}`);
    },
    receive: async () => [
      {
        id: "delivery-1",
        occurredAt: "2026-11-16T20:00:00.000Z",
        kind: "pull_request",
        data: {
          action: "opened",
          number: 23,
          repository: { full_name: "acme/widgets" },
          pull_request: {
            state: "open",
            body: "No brief here.",
            head: { sha: "abc123" },
          },
        },
      },
    ],
    pullRequestCommits: async (_repository: string, pullNumber: number) => {
      expect(pullNumber).toBe(23);
      return input.commitMessages;
    },
    publishCheck: input.publishCheck,
  } as unknown as PluginGithubProvider;
}

describe("GitHub gateway enforcement deliveries", () => {
  it("publishes one required failure and replays without repeating side effects", async () => {
    const setup = await fixture();
    const legacy = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      repository: "acme/widgets",
      accessToken: "github_pat_test-only",
      encryptionKey,
      fetcher: githubForConnection(),
    });
    const publishCheck = vi.fn().mockResolvedValue({ id: 99 });
    const plugin = await gatewayPlugin({
      workspaceId: setup.workspace.id,
      ownerId: setup.owner.id,
      commitMessages: [],
      publishCheck,
    });
    await connectGithubRepositoryWithPlugin(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      repository: "acme/widgets",
      plugin,
    });
    await finishGithubGatewayMigration(scope, {
      connectionId: legacy.id,
      pluginInstallationId: plugin.installation.installationId,
    });
    await db.query("UPDATE github_connections SET require_braino = true WHERE id = $1", [
      legacy.id,
    ]);

    const first = await deliverGithubGatewayWebhook(scope, {
      plugin,
      headers: { "x-braino-gateway-signature": "v0=signed" },
      body: "{}",
    });
    expect(first).toEqual({
      event: "pull_request",
      synced: true,
      replayed: false,
      checked: true,
      created: 0,
      updated: 0,
      unchanged: 0,
    });
    expect(publishCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "acme/widgets",
        headSha: "abc123",
        conclusion: "failure",
        title: "Didn't go through Braino",
      }),
    );

    await expect(
      deliverGithubGatewayWebhook(scope, {
        plugin,
        headers: { "x-braino-gateway-signature": "v0=signed" },
        body: "{}",
      }),
    ).resolves.toEqual({ ...first, replayed: true });
    expect(publishCheck).toHaveBeenCalledTimes(1);
  });
});
