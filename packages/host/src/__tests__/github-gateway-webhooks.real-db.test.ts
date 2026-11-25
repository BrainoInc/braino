import type { PoolClient } from "@braino/db";
import type { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.stubEnv("BRAINO_PUBLIC_HOST", "https://meta.braino.dev");
  db = await freshDb();
});

afterEach(() => vi.unstubAllEnvs());

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
  rejectPullRequest: ReturnType<typeof vi.fn>;
  publishPullRequestComment: ReturnType<typeof vi.fn>;
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
            title: "Keep the gateway safe",
            body: "No brief here.",
            html_url: "https://github.com/acme/widgets/pull/23",
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
    rejectPullRequest: input.rejectPullRequest,
    publishPullRequestComment: input.publishPullRequestComment,
  } as unknown as PluginGithubProvider;
}

async function connectedPlugin(input: {
  commitMessages: string[];
  publishCheck: ReturnType<typeof vi.fn>;
  rejectPullRequest: ReturnType<typeof vi.fn>;
  publishPullRequestComment: ReturnType<typeof vi.fn>;
}) {
  const setup = await fixture();
  const legacy = await connectGithubRepository(scope, {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    repository: "acme/widgets",
    accessToken: "github_pat_test-only",
    encryptionKey,
    fetcher: githubForConnection(),
  });
  const plugin = await gatewayPlugin({
    workspaceId: setup.workspace.id,
    ownerId: setup.owner.id,
    ...input,
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
  return { legacy, plugin };
}

const deliver = (plugin: PluginGithubProvider) =>
  deliverGithubGatewayWebhook(scope, {
    plugin,
    headers: { "x-braino-gateway-signature": "v0=signed" },
    body: "{}",
  });

describe("GitHub gateway enforcement deliveries", () => {
  it("freezes the opening failure, rejects once, and never lets later evidence reverse it", async () => {
    const publishCheck = vi.fn().mockResolvedValue({ id: 99 });
    const rejectPullRequest = vi.fn().mockResolvedValue({ id: 100 });
    const publishPullRequestComment = vi.fn().mockResolvedValue({ id: 101 });
    const { legacy, plugin } = await connectedPlugin({
      commitMessages: [],
      publishCheck,
      rejectPullRequest,
      publishPullRequestComment,
    });

    const first = await deliver(plugin);
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
    expect(rejectPullRequest).toHaveBeenCalledTimes(1);
    expect(publishPullRequestComment).not.toHaveBeenCalled();

    await expect(deliver(plugin)).resolves.toEqual({ ...first, replayed: true });
    expect(publishCheck).toHaveBeenCalledTimes(1);
    expect(rejectPullRequest).toHaveBeenCalledTimes(1);

    plugin.receive = async () => [
      {
        id: "delivery-2",
        occurredAt: "2026-11-16T20:05:00.000Z",
        kind: "pull_request",
        data: {
          action: "synchronize",
          number: 23,
          repository: { full_name: "acme/widgets" },
          pull_request: {
            state: "open",
            title: "Keep the gateway safe",
            body: "Braino-Brief: https://meta.braino.dev/workspaces/acme/brief?id=brief_01M84AAAAAAAAAAAAAAAAAAAAAA",
            html_url: "https://github.com/acme/widgets/pull/23",
            head: { sha: "def456" },
          },
        },
      },
    ];
    plugin.pullRequestCommits = async () => [
      "Late evidence\n\nBraino-Brief: https://meta.braino.dev/workspaces/acme/brief?id=brief_01M84AAAAAAAAAAAAAAAAAAAAAA",
    ];
    await deliver(plugin);

    expect(publishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ headSha: "def456", conclusion: "failure" }),
    );
    expect(rejectPullRequest).toHaveBeenCalledTimes(1);
    expect(publishPullRequestComment).not.toHaveBeenCalled();

    const verdict = await db.query<{
      went_through_braino: boolean;
      review_status: string | null;
    }>(
      `SELECT went_through_braino, review_status
         FROM github_pull_request_verdicts
        WHERE connection_id = $1 AND pull_number = 23`,
      [legacy.id],
    );
    expect(verdict.rows[0]).toEqual({
      went_through_braino: false,
      review_status: "completed",
    });
  });

  it("posts one private Braino brief link for a pull request that passed", async () => {
    const publishCheck = vi.fn().mockResolvedValue({ id: 99 });
    const rejectPullRequest = vi.fn().mockResolvedValue({ id: 100 });
    const publishPullRequestComment = vi.fn().mockResolvedValue({ id: 101 });
    const { legacy, plugin } = await connectedPlugin({
      commitMessages: [
        "Went through Braino\n\nBraino-Brief: https://meta.braino.dev/workspaces/acme/brief?id=brief_01M84AAAAAAAAAAAAAAAAAAAAAA",
      ],
      publishCheck,
      rejectPullRequest,
      publishPullRequestComment,
    });

    await deliver(plugin);

    expect(publishCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "success", title: "Went through Braino" }),
    );
    expect(rejectPullRequest).not.toHaveBeenCalled();
    expect(publishPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "acme/widgets",
        pullNumber: 23,
        body: expect.stringMatching(
          /https:\/\/meta\.braino\.dev\/workspaces\/acme\/brief\?id=brief_[0-9A-Z]+/,
        ),
      }),
    );
    plugin.receive = async () => [
      {
        id: "delivery-2",
        occurredAt: "2026-11-16T20:05:00.000Z",
        kind: "pull_request",
        data: {
          action: "synchronize",
          number: 23,
          repository: { full_name: "acme/widgets" },
          pull_request: {
            state: "open",
            title: "Keep the gateway safe",
            body: "Braino-Brief: https://meta.braino.dev/workspaces/acme/brief?id=brief_01M84AAAAAAAAAAAAAAAAAAAAAA",
            html_url: "https://github.com/acme/widgets/pull/23",
            head: { sha: "def456" },
          },
        },
      },
    ];
    await deliver(plugin);
    expect(publishPullRequestComment).toHaveBeenCalledTimes(1);

    const verdict = await db.query<{
      went_through_braino: boolean;
      brief_id: string | null;
      brief_status: string | null;
    }>(
      `SELECT went_through_braino, brief_id, brief_status
         FROM github_pull_request_verdicts
        WHERE connection_id = $1 AND pull_number = 23`,
      [legacy.id],
    );
    expect(verdict.rows[0]).toMatchObject({
      went_through_braino: true,
      brief_id: expect.stringMatching(/^brief_/),
      brief_status: "completed",
    });
  });

  it("keeps an unreadable verdict neutral and judges it when provenance becomes readable", async () => {
    const publishCheck = vi.fn().mockResolvedValue({ id: 99 });
    const rejectPullRequest = vi.fn().mockResolvedValue({ id: 100 });
    const publishPullRequestComment = vi.fn().mockResolvedValue({ id: 101 });
    const { legacy, plugin } = await connectedPlugin({
      commitMessages: [],
      publishCheck,
      rejectPullRequest,
      publishPullRequestComment,
    });
    plugin.pullRequestCommits = async () => {
      throw new Error("GitHub commits temporarily unavailable");
    };

    await deliver(plugin);

    expect(publishCheck).toHaveBeenCalledWith(
      expect.objectContaining({ conclusion: "neutral", title: "Not checked" }),
    );
    expect(rejectPullRequest).not.toHaveBeenCalled();
    expect(publishPullRequestComment).not.toHaveBeenCalled();
    const unreadable = await db.query(
      `SELECT 1 FROM github_pull_request_verdicts
        WHERE connection_id = $1 AND pull_number = 23`,
      [legacy.id],
    );
    expect(unreadable.rows).toHaveLength(0);

    plugin.receive = async () => [
      {
        id: "delivery-2",
        occurredAt: "2026-11-16T20:05:00.000Z",
        kind: "pull_request",
        data: {
          action: "synchronize",
          number: 23,
          repository: { full_name: "acme/widgets" },
          pull_request: {
            state: "open",
            title: "Keep the gateway safe",
            body: "Still no brief here.",
            html_url: "https://github.com/acme/widgets/pull/23",
            head: { sha: "def456" },
          },
        },
      },
    ];
    plugin.pullRequestCommits = async () => [];

    await deliver(plugin);

    expect(publishCheck).toHaveBeenLastCalledWith(
      expect.objectContaining({ headSha: "def456", conclusion: "failure" }),
    );
    expect(rejectPullRequest).toHaveBeenCalledTimes(1);
  });

  it("has no Braino-side enforcement flag", async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'github_connections'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("require_braino");
  });
});
