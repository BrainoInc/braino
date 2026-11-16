import type { PoolClient } from "@doco/db";
import type { PluginCapabilityName, PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  assignWorkspaceModelPlugin,
  getWorkspaceModelPluginReadiness,
  verifyWorkspaceModelPlugins,
} from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "model-verification-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";

function manifest(id: string, capability: PluginCapabilityName): PluginManifest {
  return {
    protocolVersion: 2,
    id,
    name: id,
    version: "1.0.0",
    capabilities: { [capability]: 1 },
    permissions: { network: ["ollama:11434"] },
    configurationSchema: {
      type: "object",
      properties: { model: { type: "string" } },
      additionalProperties: false,
    },
  };
}

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const component = new TextEncoder().encode("component");
  await assignWorkspaceModelPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    capability: "chat.complete",
    plugin: {
      manifest: manifest("acme.chat", "chat.complete"),
      component,
      configuration: { model: "small-chat" },
    },
  });
  await assignWorkspaceModelPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    capability: "embedding.embed",
    plugin: {
      manifest: manifest("acme.embedding", "embedding.embed"),
      component,
      configuration: { model: "small-embedding" },
    },
  });
  return setup;
}

describe("workspace model verification", () => {
  it("keeps configured plugins unready until both answer, then stores observed dimensions", async () => {
    const setup = await fixture();
    await db.query("UPDATE plugin_installations SET updated_at = '2026-11-16 13:03:03.241335+00'");
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "unverified",
      embedding: "unverified",
    });

    let activeCalls = 0;
    let maxActiveCalls = 0;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      const envelope = JSON.parse(String(init?.body));
      const response = Response.json({
        outputJson:
          envelope.capability === "chat.complete"
            ? JSON.stringify({ content: "OK", model: "local:small-chat" })
            : JSON.stringify({
                model: "local:small-embedding",
                dimensions: 3,
                vectors: [[0.1, 0.2, 0.3]],
              }),
      });
      activeCalls -= 1;
      return response;
    }) as typeof fetch;

    await expect(
      verifyWorkspaceModelPlugins(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).resolves.toEqual({
      chatModel: "local:small-chat",
      embeddingModel: "local:small-embedding",
      embeddingDimensions: 3,
    });
    expect(maxActiveCalls).toBe(1);

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: true,
      chat: "ready",
      embedding: "ready",
    });
    const stored = await db.query<{
      configuration: Record<string, string>;
      verified_embedding_dimensions: number;
    }>(
      `SELECT configuration, verified_embedding_dimensions
         FROM plugin_installations
        WHERE manifest->>'id' = 'acme.embedding'`,
    );
    expect(stored.rows[0]).toEqual({
      configuration: { model: "small-embedding" },
      verified_embedding_dimensions: 3,
    });
  });

  it("marks neither plugin verified when either live check fails", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      if (envelope.capability === "embedding.embed") {
        return Response.json({ error: { code: "plugin_error" } }, { status: 422 });
      }
      return Response.json({
        outputJson: JSON.stringify({ content: "OK", model: "local:small-chat" }),
      });
    }) as typeof fetch;

    await expect(
      verifyWorkspaceModelPlugins(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken },
        fetcher,
      }),
    ).rejects.toMatchObject({ kind: "embedding", code: "plugin_error" });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "unverified",
      embedding: "unverified",
    });
  });
});
