import { createHmac } from "node:crypto";
import { createGithubAppPlugin } from "@doco/connector-plugins";
import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  connectGithubRepository,
  deliverGithubAppWebhook,
  setGithubEnforcement,
  syncGithubConnection,
} from "../github-connections.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const scope = <T>(operation: (client: PoolClient) => Promise<T>) => operation(client());

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

function github() {
  const checks: unknown[] = [];
  const rules: unknown[] = [];
  let rulesets: Array<{ id: number; name: string }> = [];
  let commitMessages = ["Implement without a brief"];
  let syncFails = false;
  const fetcher = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.pathname === "/app/installations/7/access_tokens") {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer app-jwt");
      return Response.json({ token: "installation-token", expires_at: "later" });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
    if (url.pathname === "/installation/repositories") {
      return Response.json({
        repositories: [{ full_name: "acme/widgets", default_branch: "main" }],
      });
    }
    if (url.pathname === "/repos/acme/widgets") {
      return Response.json({ full_name: "acme/widgets", default_branch: "main" });
    }
    if (url.pathname === "/repos/acme/widgets/issues") {
      if (syncFails) return new Response("sync failed", { status: 503 });
      return Response.json([]);
    }
    if (url.pathname === "/repos/acme/widgets/pulls") {
      return Response.json([
        {
          number: 23,
          title: "Protect merges",
          body: "Adds the App check.",
          html_url: "https://github.com/acme/widgets/pull/23",
          state: "open",
          draft: false,
          merged_at: null,
          created_at: "2026-11-16T10:00:00Z",
          updated_at: "2026-11-16T11:00:00Z",
          user: { login: "octo" },
          labels: [],
          head: { ref: "app", sha: "head-sha" },
          base: { ref: "main" },
        },
      ]);
    }
    if (url.pathname === "/repos/acme/widgets/git/trees/main") {
      return Response.json({ truncated: false, tree: [] });
    }
    if (url.pathname === "/repos/acme/widgets/pulls/23/commits") {
      return Response.json(commitMessages.map((message) => ({ commit: { message } })));
    }
    if (url.pathname === "/repos/acme/widgets/check-runs" && init?.method === "POST") {
      checks.push(JSON.parse(String(init.body)));
      return Response.json({ id: checks.length }, { status: 201 });
    }
    if (url.pathname === "/repos/acme/widgets/rulesets" && init?.method === "GET") {
      return Response.json(rulesets);
    }
    if (url.pathname === "/repos/acme/widgets/rulesets" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      rules.push(body);
      rulesets = [{ id: 42, name: "Braino" }];
      return Response.json({ id: 42 }, { status: 201 });
    }
    if (url.pathname === "/repos/acme/widgets/rulesets/42" && init?.method === "DELETE") {
      rulesets = [];
      return new Response(null, { status: 204 });
    }
    return new Response(`not found: ${url.pathname}`, { status: 404 });
  }) as typeof fetch;
  return {
    plugin: createGithubAppPlugin({
      credentials: { appId: 99, privateKey: "unused", webhookSecret: "webhook-secret" },
      fetcher,
      jwt: () => "app-jwt",
    }),
    fetcher,
    checks,
    rules,
    setCommitMessages(value: string[]) {
      commitMessages = value;
    },
    failSync() {
      syncFails = true;
    },
  };
}

describe("GitHub App repository connections", () => {
  it("stores the installation instead of a personal token and reconciles enforcement", async () => {
    const setup = await fixture();
    const provider = github();
    const connection = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: 7,
      repository: "acme/widgets",
      plugin: provider.plugin,
    });

    expect(connection).toMatchObject({
      repository: "acme/widgets",
      installationId: 7,
      requireBraino: false,
      appConnected: true,
    });
    expect(
      (
        await db.query<{ installation_id: string }>(
          "SELECT installation_id::text FROM github_connections",
        )
      ).rows[0],
    ).toEqual({ installation_id: "7" });
    expect(
      (
        await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_name = 'github_connections'
              AND column_name IN
                ('token_sealed', 'webhook_id', 'webhook_secret_sealed',
                 'webhook_url', 'webhook_created_at')`,
        )
      ).rows,
    ).toEqual([]);

    await expect(
      syncGithubConnection(scope, {
        connectionId: connection.id,
        plugin: provider.plugin,
        fetcher: provider.fetcher,
        codeGraphClient: null,
      }),
    ).resolves.toEqual({ created: 1, updated: 0, unchanged: 0 });

    await expect(
      setGithubEnforcement(scope, {
        connectionId: connection.id,
        userId: setup.owner.id,
        required: true,
        plugin: provider.plugin,
      }),
    ).resolves.toMatchObject({ requireBraino: true });
    expect(provider.rules).toHaveLength(1);
  });

  it("fails an unevidenced pull request and passes it after a Braino brief trailer", async () => {
    const setup = await fixture();
    const provider = github();
    const connection = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: 7,
      repository: "acme/widgets",
      plugin: provider.plugin,
    });
    await setGithubEnforcement(scope, {
      connectionId: connection.id,
      userId: setup.owner.id,
      required: true,
      plugin: provider.plugin,
    });

    const payload = JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "acme/widgets" },
      pull_request: {
        number: 23,
        state: "open",
        body: "Adds the App check.",
        head: { sha: "head-sha" },
      },
    });
    const headers = {
      "x-github-delivery": "delivery-1",
      "x-github-event": "pull_request",
      "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret")
        .update(payload)
        .digest("hex")}`,
    };
    await deliverGithubAppWebhook(scope, {
      plugin: provider.plugin,
      headers,
      body: payload,
      fetcher: provider.fetcher,
      codeGraphClient: null,
    });
    expect(provider.checks.at(-1)).toMatchObject({
      name: "Braino",
      conclusion: "failure",
      output: { title: "Didn't go through Braino" },
    });

    provider.setCommitMessages([
      "Record the decision\n\nDoco-Brief: https://doco.to/workspaces/acme/brief?id=brief_01TEST",
    ]);
    const secondPayload = payload.replace("head-sha", "head-sha-2");
    await deliverGithubAppWebhook(scope, {
      plugin: provider.plugin,
      headers: {
        ...headers,
        "x-github-delivery": "delivery-2",
        "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret")
          .update(secondPayload)
          .digest("hex")}`,
      },
      body: secondPayload,
      fetcher: provider.fetcher,
      codeGraphClient: null,
    });
    expect(provider.checks.at(-1)).toMatchObject({
      name: "Braino",
      head_sha: "head-sha-2",
      conclusion: "success",
      output: { title: "Went through Braino" },
    });
  });

  it("publishes the enforcement check before an unrelated repository sync fails", async () => {
    const setup = await fixture();
    const provider = github();
    const connection = await connectGithubRepository(scope, {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      installationId: 7,
      repository: "acme/widgets",
      plugin: provider.plugin,
    });
    await setGithubEnforcement(scope, {
      connectionId: connection.id,
      userId: setup.owner.id,
      required: true,
      plugin: provider.plugin,
    });
    provider.failSync();
    const body = JSON.stringify({
      action: "synchronize",
      installation: { id: 7 },
      repository: { full_name: "acme/widgets" },
      pull_request: {
        number: 23,
        state: "open",
        body: "No evidence",
        head: { sha: "new-head" },
      },
    });

    await expect(
      deliverGithubAppWebhook(scope, {
        plugin: provider.plugin,
        headers: {
          "x-github-delivery": "delivery-sync-failure",
          "x-github-event": "pull_request",
          "x-hub-signature-256": `sha256=${createHmac("sha256", "webhook-secret")
            .update(body)
            .digest("hex")}`,
        },
        body,
        fetcher: provider.fetcher,
        codeGraphClient: null,
      }),
    ).rejects.toThrow("503");
    expect(provider.checks.at(-1)).toMatchObject({
      head_sha: "new-head",
      conclusion: "failure",
    });
  });
});
