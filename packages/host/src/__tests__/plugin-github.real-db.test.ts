import type { PoolClient } from "@braino/db";
import type { PluginManifest } from "@braino/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { connectWorkspaceGithubPlugin, resolveWorkspaceGithubPlugin } from "../plugin-github.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "github-gateway-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";

const manifest: PluginManifest = {
  protocolVersion: 2,
  id: "braino.github",
  name: "GitHub",
  version: "1.0.0",
  capabilities: {
    "event.receive": 1,
    "scm.request": 1,
    "scm.check.publish": 1,
    "scm.review.reject": 1,
  },
  permissions: { network: ["plugins.braino.dev"] },
  configurationSchema: {
    type: "object",
    properties: {
      gateway_url: { type: "string" },
      installation_id: { type: "string" },
    },
    required: ["gateway_url", "installation_id"],
    additionalProperties: false,
  },
  secretSchema: {
    type: "object",
    properties: { gateway_secret: { type: "string" } },
    required: ["gateway_secret"],
    additionalProperties: false,
  },
};

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

describe("workspace GitHub gateway plugin", () => {
  it("stores only the scoped gateway credential and live-verifies repository access", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const invocation = JSON.parse(String(init?.body));
      expect(invocation.capability).toBe("scm.request");
      expect(invocation.configuration).toEqual({
        gateway_url: "https://plugins.braino.dev",
        installation_id: "installation_gateway",
      });
      expect(invocation.secrets).toEqual({ gateway_secret: "scoped-secret" });
      expect(JSON.stringify(invocation)).not.toContain("PRIVATE KEY");
      expect(JSON.stringify(invocation)).not.toContain("ghs_");
      return Response.json({
        outputJson: JSON.stringify({
          data: {
            repositories: [{ full_name: "BrainoInc/braino", default_branch: "main" }],
          },
          next: null,
        }),
      });
    }) as typeof fetch;

    const connected = await connectWorkspaceGithubPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest,
      component: new TextEncoder().encode("github component"),
      configuration: {
        gateway_url: "https://plugins.braino.dev",
        installation_id: "installation_gateway",
      },
      secrets: { gateway_secret: "scoped-secret" },
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher,
    });

    expect(connected.repositories).toEqual([
      { fullName: "BrainoInc/braino", defaultBranch: "main" },
    ]);
    expect(connected.installation.manifest.id).toBe("braino.github");
    const stored = await db.query<{ name: string; value_sealed: string }>(
      `SELECT name, value_sealed FROM plugin_installation_secrets
        WHERE installation_id = $1`,
      [connected.installation.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.name).toBe("gateway_secret");
    expect(stored.rows[0]?.value_sealed).not.toContain("scoped-secret");
  });

  it("resolves the workspace-scoped provider for reads, checks, rejection reviews, and events", async () => {
    const setup = await fixture();
    const outputs = [
      { data: { full_name: "BrainoInc/braino", default_branch: "main" }, next: null },
      { id: 9001 },
      { id: 9002 },
      [
        {
          id: "delivery-1",
          occurredAt: "2026-11-16T20:00:00.000Z",
          kind: "pull_request",
          data: { action: "opened" },
        },
      ],
    ];
    const fetcher = vi.fn(async () =>
      Response.json({ outputJson: JSON.stringify(outputs.shift()) }),
    ) as typeof fetch;
    const connected = await connectWorkspaceGithubPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest,
      component: new TextEncoder().encode("github component"),
      configuration: {
        gateway_url: "https://plugins.braino.dev",
        installation_id: "installation_gateway",
      },
      secrets: { gateway_secret: "scoped-secret" },
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher: vi.fn(async () =>
        Response.json({
          outputJson: JSON.stringify({ data: { repositories: [] }, next: null }),
        }),
      ) as typeof fetch,
    });
    const provider = await resolveWorkspaceGithubPlugin(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher,
    });

    await expect(
      provider?.request({ method: "GET", path: "/repos/BrainoInc/braino" }),
    ).resolves.toEqual({
      data: { full_name: "BrainoInc/braino", default_branch: "main" },
      next: null,
    });
    await expect(
      provider?.publishCheck({
        repository: "BrainoInc/braino",
        name: "Braino",
        headSha: "abc123",
        conclusion: "failure",
        title: "Didn't go through Braino",
        summary: "No Braino brief was found.",
      }),
    ).resolves.toEqual({ id: 9001 });
    await expect(
      provider?.rejectPullRequest({
        repository: "BrainoInc/braino",
        pullNumber: 42,
        body: "This pull request did not go through Braino.",
        commitId: "abc123",
      }),
    ).resolves.toEqual({ id: 9002 });
    await expect(
      provider?.receive({
        body: "{}",
        headers: { "x-braino-gateway-signature": "v0=signature" },
        receivedAt: 1_794_800_000,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: "delivery-1" })]);
    expect(connected.installation.id).toBe(provider?.installation.installationId);
  });
});
