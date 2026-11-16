import type { PoolClient } from "@doco/db";
import type { PluginCapabilityName, PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  installPlugin,
  listPluginInstallations,
  listPluginSecretNames,
} from "../plugin-installations.js";
import { openSecret } from "../secret-box.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  assignWorkspaceModelPlugin,
  getWorkspaceModelPluginReadiness,
} from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

function manifest(
  id: string,
  capability: PluginCapabilityName,
  options: { apiKey?: boolean } = {},
): PluginManifest {
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
    ...(options.apiKey
      ? {
          secretSchema: {
            type: "object",
            properties: { api_key: { type: "string" } },
            required: ["api_key"],
            additionalProperties: false,
          },
        }
      : {}),
  };
}

describe("required workspace model plugins", () => {
  it("keeps configured model plugins unverified until their live checks pass", async () => {
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
      chat: "unverified",
      embedding: "missing",
    });

    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: manifest("acme.embedding", "embedding.embed"),
      component: new TextEncoder().encode("embedding"),
      configuration: { model: "embeddinggemma" },
    });
    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "unverified",
      embedding: "unverified",
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
      configuration: { model: " " },
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "ambiguous",
      embedding: "invalid",
    });
  });

  it("requires declared provider secrets before either capability is ready", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });
    const component = new TextEncoder().encode("component");
    const encryptionKey = "provider-secret-test-key-with-more-than-thirty-two-characters";

    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: manifest("acme.chat", "chat.complete", { apiKey: true }),
      component,
      configuration: { model: "gpt-4.1-mini" },
    });
    await installPlugin(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      manifest: manifest("acme.embedding", "embedding.embed", { apiKey: true }),
      component,
      configuration: { model: "text-embedding-3-small" },
      secrets: { api_key: "sk-test" },
      encryptionKey,
    });

    await expect(getWorkspaceModelPluginReadiness(client(), setup.workspace.id)).resolves.toEqual({
      ready: false,
      chat: "invalid",
      embedding: "unverified",
    });
  });
});

describe("assigning one plugin to one model", () => {
  const component = new TextEncoder().encode("component");
  const encryptionKey = "provider-secret-test-key-with-more-than-thirty-two-characters";

  async function workspace() {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "acme",
      workspaceName: "Acme",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Acme Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });
    return { workspaceId: setup.workspace.id, userId: setup.owner.id };
  }

  async function enabledPlugins(owner: { workspaceId: string; userId: string }) {
    const installed = await listPluginInstallations(client(), owner);
    return installed.filter((plugin) => plugin.enabled).map((plugin) => plugin.manifest.id);
  }

  async function assignLocalDefaults(owner: { workspaceId: string; userId: string }) {
    await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("local.chat", "chat.complete"),
        component,
        configuration: { model: "qwen3.5:2b" },
      },
    });
    return assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "embedding.embed",
      plugin: {
        manifest: manifest("local.embedding", "embedding.embed"),
        component,
        configuration: { model: "embeddinggemma-2:270m" },
      },
    });
  }

  it("switches chat to another plugin without touching the embedding assignment", async () => {
    const owner = await workspace();
    const embedding = await assignLocalDefaults(owner);

    await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("cloud.chat", "chat.complete", { apiKey: true }),
        component,
        configuration: { model: "gpt-4.1-mini" },
        secrets: { api_key: "sk-chat" },
        encryptionKey,
      },
    });

    expect(await enabledPlugins(owner)).toEqual(["cloud.chat", "local.embedding"]);
    const installed = await listPluginInstallations(client(), owner);
    expect(installed.map((plugin) => plugin.manifest.id)).toEqual([
      "cloud.chat",
      "local.chat",
      "local.embedding",
    ]);
    const untouched = installed.find((plugin) => plugin.id === embedding.id);
    expect(untouched).toMatchObject({
      enabled: true,
      configuration: { model: "embeddinggemma-2:270m" },
      updatedAt: embedding.updatedAt,
    });
    await expect(getWorkspaceModelPluginReadiness(client(), owner.workspaceId)).resolves.toEqual({
      ready: false,
      chat: "unverified",
      embedding: "unverified",
    });
  });

  it("switches embeddings to another plugin while chat stays where it was", async () => {
    const owner = await workspace();
    await assignLocalDefaults(owner);

    await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "embedding.embed",
      plugin: {
        manifest: manifest("cloud.embedding", "embedding.embed", { apiKey: true }),
        component,
        configuration: { model: "text-embedding-3-small" },
        secrets: { api_key: "sk-embedding" },
        encryptionKey,
      },
    });

    expect(await enabledPlugins(owner)).toEqual(["cloud.embedding", "local.chat"]);
  });

  it("rejects a plugin whose required secret is missing and changes nothing", async () => {
    const owner = await workspace();
    await assignLocalDefaults(owner);

    await expect(
      assignWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "chat.complete",
        plugin: {
          manifest: manifest("cloud.chat", "chat.complete", { apiKey: true }),
          component,
          configuration: { model: "gpt-4.1-mini" },
        },
      }),
    ).rejects.toMatchObject({ code: "secret_required" });

    const installed = await listPluginInstallations(client(), owner);
    expect(installed.map((plugin) => [plugin.manifest.id, plugin.enabled])).toEqual([
      ["local.chat", true],
      ["local.embedding", true],
    ]);
  });

  it("stores each plugin's secret under its own installation", async () => {
    const owner = await workspace();
    const chat = await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("cloud.chat", "chat.complete", { apiKey: true }),
        component,
        configuration: { model: "gpt-4.1-mini" },
        secrets: { api_key: "sk-chat" },
        encryptionKey,
      },
    });
    // The embedding plugin comes from the same provider and still has no key of its own.
    await expect(
      assignWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        plugin: {
          manifest: manifest("cloud.embedding", "embedding.embed", { apiKey: true }),
          component,
          configuration: { model: "text-embedding-3-small" },
        },
      }),
    ).rejects.toMatchObject({ code: "secret_required" });
    const embedding = await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "embedding.embed",
      plugin: {
        manifest: manifest("cloud.embedding", "embedding.embed", { apiKey: true }),
        component,
        configuration: { model: "text-embedding-3-small" },
        secrets: { api_key: "sk-embedding" },
        encryptionKey,
      },
    });

    expect(embedding.id).not.toBe(chat.id);
    for (const installation of [chat, embedding]) {
      await expect(
        listPluginSecretNames(client(), { ...owner, installationId: installation.id }),
      ).resolves.toEqual(["api_key"]);
    }
    const stored = await db.query<{ installation_id: string; value_sealed: string }>(
      "SELECT installation_id, value_sealed FROM plugin_installation_secrets",
    );
    const opened = Object.fromEntries(
      stored.rows.map((row) => [row.installation_id, openSecret(row.value_sealed, encryptionKey)]),
    );
    expect(opened).toEqual({ [chat.id]: "sk-chat", [embedding.id]: "sk-embedding" });
  });

  it("keeps a stored secret when the same plugin is assigned again with a new model", async () => {
    const owner = await workspace();
    const cloudChat = {
      manifest: manifest("cloud.chat", "chat.complete", { apiKey: true }),
      component,
    };
    const first = await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        ...cloudChat,
        configuration: { model: "gpt-4.1-mini" },
        secrets: { api_key: "sk-chat" },
        encryptionKey,
      },
    });

    const second = await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: { ...cloudChat, configuration: { model: "gpt-4.1" } },
    });

    expect(second).toMatchObject({ id: first.id, configuration: { model: "gpt-4.1" } });
    await expect(
      listPluginSecretNames(client(), { ...owner, installationId: first.id }),
    ).resolves.toEqual(["api_key"]);
  });

  it("clears an ambiguous assignment by keeping only the chosen plugin", async () => {
    const owner = await workspace();
    for (const id of ["acme.chat-one", "acme.chat-two"]) {
      await installPlugin(client(), {
        ...owner,
        manifest: manifest(id, "chat.complete"),
        component,
        configuration: { model: "qwen3.5:2b" },
      });
    }

    await assignWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("acme.chat-two", "chat.complete"),
        component,
        configuration: { model: "qwen3.5:2b" },
      },
    });

    expect(await enabledPlugins(owner)).toEqual(["acme.chat-two"]);
  });

  it("rejects a plugin for a model it does not provide, and an unusable configuration", async () => {
    const owner = await workspace();

    await expect(
      assignWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        plugin: {
          manifest: manifest("local.chat", "chat.complete"),
          component,
          configuration: { model: "qwen3.5:2b" },
        },
      }),
    ).rejects.toMatchObject({ code: "capability_not_provided" });
    await expect(
      assignWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        plugin: {
          manifest: manifest("local.embedding", "embedding.embed"),
          component,
          configuration: { model: " " },
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    await expect(
      assignWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "chat.complete",
        plugin: {
          manifest: manifest("local.chat", "chat.complete"),
          component,
          configuration: { model: "  " },
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(await listPluginInstallations(client(), owner)).toEqual([]);
  });
});
