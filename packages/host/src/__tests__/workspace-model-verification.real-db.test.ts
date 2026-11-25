import type { PoolClient } from "@braino/db";
import type { PluginCapabilityName, PluginManifest } from "@braino/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  activateWorkspaceModelPlugin,
  getWorkspaceModelPluginReadiness,
  installWorkspaceModelPlugin,
  verifyWorkspaceModelPlugin,
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

async function fixture(options: { embedding?: boolean } = { embedding: true }) {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const component = new TextEncoder().encode("component");
  const chat = await installWorkspaceModelPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    capability: "chat.complete",
    plugin: {
      manifest: manifest("acme.chat", "chat.complete"),
      component,
      configuration: { model: "small-chat" },
    },
  });
  if (options.embedding) {
    const embedding = await installWorkspaceModelPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      capability: "embedding.embed",
      plugin: {
        manifest: manifest("acme.embedding", "embedding.embed"),
        component,
        configuration: { model: "small-embedding" },
      },
    });
    return { ...setup, chatId: chat.id, embeddingId: embedding.id };
  }
  return { ...setup, chatId: chat.id, embeddingId: null };
}

describe("workspace model verification", () => {
  it("verifies chat before an embedding plugin is installed", async () => {
    const setup = await fixture({ embedding: false });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "missing",
      embedding: "missing",
    });

    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.capability).toBe("chat.complete");
      return Response.json({
        outputJson: JSON.stringify({ content: "OK", model: "local:small-chat" }),
      });
    }) as typeof fetch;

    await expect(
      verifyWorkspaceModelPlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: setup.chatId,
        capability: "chat.complete",
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
        fetcher,
      }),
    ).resolves.toEqual({ model: "local:small-chat" });
    await activateWorkspaceModelPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      capability: "chat.complete",
      installationId: setup.chatId,
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "ready",
      embedding: "missing",
    });
  });

  it("verifies embeddings independently and stores observed dimensions", async () => {
    const setup = await fixture();
    const embeddingId = setup.embeddingId;
    if (!embeddingId) throw new Error("Expected an embedding plugin installation.");
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body));
      expect(envelope.capability).toBe("embedding.embed");
      return Response.json({
        outputJson: JSON.stringify({
          model: "local:small-embedding",
          dimensions: 3,
          vectors: [[0.1, 0.2, 0.3]],
        }),
      });
    }) as typeof fetch;

    await expect(
      verifyWorkspaceModelPlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: embeddingId,
        capability: "embedding.embed",
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
        fetcher,
      }),
    ).resolves.toEqual({ model: "local:small-embedding", dimensions: 3 });
    await activateWorkspaceModelPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      capability: "embedding.embed",
      installationId: embeddingId,
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "missing",
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

  it("keeps an already verified chat plugin ready when embedding verification fails", async () => {
    const setup = await fixture();
    const embeddingId = setup.embeddingId;
    if (!embeddingId) throw new Error("Expected an embedding plugin installation.");
    const chatFetcher = vi.fn(async () =>
      Response.json({
        outputJson: JSON.stringify({ content: "OK", model: "local:small-chat" }),
      }),
    ) as typeof fetch;
    await verifyWorkspaceModelPlugin(client(), {
      workspaceId: setup.workspace.id,
      installationId: setup.chatId,
      capability: "chat.complete",
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher: chatFetcher,
    });
    await activateWorkspaceModelPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      capability: "chat.complete",
      installationId: setup.chatId,
    });
    const embeddingFetcher = vi.fn(async () =>
      Response.json({ error: { code: "plugin_error" } }, { status: 422 }),
    ) as typeof fetch;

    await expect(
      verifyWorkspaceModelPlugin(client(), {
        workspaceId: setup.workspace.id,
        installationId: embeddingId,
        capability: "embedding.embed",
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
        fetcher: embeddingFetcher,
      }),
    ).rejects.toMatchObject({ kind: "embedding", code: "plugin_error" });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "ready",
      embedding: "missing",
    });
  });
});
