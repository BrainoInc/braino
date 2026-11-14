import type { PoolClient } from "@doco/db";
import type { PluginCapabilityName, PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  getWorkspaceModelPluginReadiness,
  installRequiredModelPlugins,
} from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

function manifest(id: string, capability: PluginCapabilityName): PluginManifest {
  return {
    protocolVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    capabilities: [capability],
    permissions: { network: ["ollama:11434"] },
    configurationSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        ...(capability === "embedding.embed" ? { dimensions: { type: "string" } } : {}),
      },
      additionalProperties: false,
    },
  };
}

describe("required workspace model plugins", () => {
  it("is ready only with one configured chat plugin and one configured embedding plugin", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "missing",
      embedding: "missing",
    });

    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: manifest("acme.chat", "chat.complete"),
      component: new TextEncoder().encode("chat"),
      configuration: { model: "qwen3:0.6b" },
    });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "ready",
      embedding: "missing",
    });

    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: manifest("acme.embedding", "embedding.embed"),
      component: new TextEncoder().encode("embedding"),
      configuration: { model: "embeddinggemma", dimensions: "768" },
    });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: true,
      chat: "ready",
      embedding: "ready",
    });
  });

  it("rejects ambiguous and incomplete model configurations", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });
    const base = {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      component: new TextEncoder().encode("component"),
    };
    await installPlugin(client(), {
      ...base,
      manifest: manifest("acme.chat-one", "chat.complete"),
      configuration: { model: "qwen3:0.6b" },
    });
    await installPlugin(client(), {
      ...base,
      manifest: manifest("acme.chat-two", "chat.complete"),
      configuration: { model: "qwen3:0.6b" },
    });
    await installPlugin(client(), {
      ...base,
      manifest: manifest("acme.embedding", "embedding.embed"),
      configuration: { model: "embeddinggemma", dimensions: "not-a-number" },
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "ambiguous",
      embedding: "invalid",
    });
  });

  it("installs the required pair as one setup operation", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });
    const component = new TextEncoder().encode("component");

    await expect(
      installRequiredModelPlugins(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        chat: {
          manifest: manifest("acme.chat", "chat.complete"),
          component,
          configuration: { model: "qwen3:0.6b" },
        },
        embedding: {
          manifest: manifest("acme.embedding", "embedding.embed"),
          component,
          configuration: { model: "embeddinggemma", dimensions: "768" },
        },
      }),
    ).resolves.toEqual({ ready: true, chat: "ready", embedding: "ready" });
  });
});
