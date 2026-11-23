import type { PoolClient } from "@doco/db";
import type {
  PluginEvent,
  PluginEventRequest,
  PluginManifest,
  ScmCheckPublishInput,
  ScmRequestInput,
  ScmRequestOutput,
  ScmReviewRejectInput,
} from "@doco/plugin-runtime";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
} from "./plugin-installations.js";
import { type PluginHostConnection, invokePlugin } from "./plugin-invocation.js";

type Fetcher = typeof fetch;

interface GithubInstallationRow {
  id: string;
  plugin_id: string;
}

export interface GithubRepository {
  fullName: string;
  defaultBranch: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInstallationError(`${label} is invalid.`, "plugin_output_invalid", 502);
  }
  return value as Record<string, unknown>;
}

function requestOutput(value: unknown): ScmRequestOutput {
  const output = object(value, "GitHub gateway response");
  if (output.next !== null && typeof output.next !== "string") {
    throw new PluginInstallationError(
      "GitHub gateway pagination is invalid.",
      "plugin_output_invalid",
      502,
    );
  }
  return { data: output.data, next: output.next as string | null };
}

/** The one workspace-scoped GitHub provider. Provider credentials stay in the gateway. */
export class PluginGithubProvider {
  constructor(
    private readonly client: PoolClient,
    readonly installation: {
      workspaceId: string;
      installationId: string;
      pluginId: string;
    },
    private readonly connection: {
      encryptionKey: string;
      host: PluginHostConnection;
      fetcher?: Fetcher;
    },
  ) {}

  private invoke(
    capability: "event.receive" | "scm.request" | "scm.check.publish" | "scm.review.reject",
    input: unknown,
  ) {
    return invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability,
      input,
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    });
  }

  async request(input: ScmRequestInput): Promise<ScmRequestOutput> {
    return requestOutput(await this.invoke("scm.request", input));
  }

  async repositories(): Promise<readonly GithubRepository[]> {
    const repositories: GithubRepository[] = [];
    let path: string | null = "/installation/repositories?per_page=100";
    for (let page = 0; path && page < 100; page += 1) {
      const output = await this.request({ method: "GET", path });
      const value = object(output.data, "GitHub repository list");
      if (!Array.isArray(value.repositories)) {
        throw new PluginInstallationError(
          "GitHub repository list is invalid.",
          "plugin_output_invalid",
          502,
        );
      }
      for (const item of value.repositories) {
        const repository = object(item, "GitHub repository");
        if (
          typeof repository.full_name !== "string" ||
          typeof repository.default_branch !== "string"
        ) {
          throw new PluginInstallationError(
            "GitHub repository is invalid.",
            "plugin_output_invalid",
            502,
          );
        }
        repositories.push({
          fullName: repository.full_name,
          defaultBranch: repository.default_branch,
        });
      }
      path = output.next;
    }
    if (path) {
      throw new PluginInstallationError(
        "GitHub repository pagination exceeded 100 pages.",
        "github_too_large",
        422,
      );
    }
    return repositories;
  }

  async pullRequestCommits(repository: string, pullNumber: number): Promise<readonly string[]> {
    const messages: string[] = [];
    let path: string | null = `/repos/${repository}/pulls/${pullNumber}/commits?per_page=100`;
    for (let page = 0; path && page < 100; page += 1) {
      const output = await this.request({ method: "GET", path });
      if (!Array.isArray(output.data)) {
        throw new PluginInstallationError(
          "GitHub pull-request commits are invalid.",
          "plugin_output_invalid",
          502,
        );
      }
      for (const item of output.data) {
        const commit = object(object(item, "GitHub commit").commit, "GitHub commit data");
        if (typeof commit.message !== "string") {
          throw new PluginInstallationError(
            "GitHub commit message is invalid.",
            "plugin_output_invalid",
            502,
          );
        }
        messages.push(commit.message);
      }
      path = output.next;
    }
    if (path) {
      throw new PluginInstallationError(
        "GitHub commit pagination exceeded 100 pages.",
        "github_too_large",
        422,
      );
    }
    return messages;
  }

  async publishCheck(input: ScmCheckPublishInput): Promise<{ id: number }> {
    const output = object(await this.invoke("scm.check.publish", input), "GitHub check response");
    const id = Number(output.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PluginInstallationError(
        "GitHub check response is invalid.",
        "plugin_output_invalid",
        502,
      );
    }
    return { id };
  }

  async rejectPullRequest(input: ScmReviewRejectInput): Promise<{ id: number }> {
    const output = object(await this.invoke("scm.review.reject", input), "GitHub review response");
    const id = Number(output.id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PluginInstallationError(
        "GitHub review response is invalid.",
        "plugin_output_invalid",
        502,
      );
    }
    return { id };
  }

  async publishPullRequestComment(input: {
    repository: string;
    pullNumber: number;
    body: string;
  }): Promise<{ id: number }> {
    const output = await this.request({
      method: "POST",
      path: `/repos/${input.repository}/issues/${input.pullNumber}/comments`,
      body: { body: input.body },
    });
    const id = Number(object(output.data, "GitHub comment response").id);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new PluginInstallationError(
        "GitHub comment response is invalid.",
        "plugin_output_invalid",
        502,
      );
    }
    return { id };
  }

  async receive(input: PluginEventRequest): Promise<readonly PluginEvent[]> {
    return (await this.invoke("event.receive", input)) as readonly PluginEvent[];
  }
}

export async function resolveWorkspaceGithubPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginGithubProvider | null> {
  const found = await client.query<GithubInstallationRow>(
    `SELECT id, manifest->>'id' AS plugin_id
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND manifest->>'id' = 'braino.github'
        AND manifest->'capabilities' ?& ARRAY[
          'event.receive', 'scm.request', 'scm.check.publish', 'scm.review.reject'
        ]
      ORDER BY id`,
    [input.workspaceId],
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1) {
    throw new PluginInstallationError(
      "Only one GitHub plugin can be enabled per workspace.",
      "github_plugin_ambiguous",
      409,
    );
  }
  const row = found.rows[0];
  if (!row) return null;
  return new PluginGithubProvider(
    client,
    {
      workspaceId: input.workspaceId,
      installationId: row.id,
      pluginId: row.plugin_id,
    },
    {
      encryptionKey: input.encryptionKey,
      host: input.host,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    },
  );
}

export async function connectWorkspaceGithubPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    manifest: PluginManifest;
    component: Uint8Array;
    configuration: Record<string, string>;
    secrets: Readonly<Record<string, string>>;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<{ installation: PluginInstallation; repositories: readonly GithubRepository[] }> {
  await client.query("BEGIN");
  try {
    const installation = await installPluginInTransaction(client, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      manifest: input.manifest,
      component: input.component,
      configuration: input.configuration,
      secrets: input.secrets,
      encryptionKey: input.encryptionKey,
    });
    await client.query(
      `UPDATE plugin_installations
          SET enabled = false, updated_by_user_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND id <> $2 AND enabled
          AND manifest->>'id' = 'braino.github'`,
      [input.workspaceId, installation.id, input.userId],
    );
    const provider = new PluginGithubProvider(
      client,
      {
        workspaceId: input.workspaceId,
        installationId: installation.id,
        pluginId: installation.manifest.id,
      },
      {
        encryptionKey: input.encryptionKey,
        host: input.host,
        ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      },
    );
    const repositories = await provider.repositories();
    await client.query("COMMIT");
    return { installation, repositories };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
