import type { PoolClient } from "@braino/db";
import type { PluginCapabilityName, PluginManifest } from "@braino/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { listPluginInstallations, listPluginSecretNames } from "../plugin-installations.js";
import { openSecret } from "../secret-box.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import { installWorkspaceModelPlugin } from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const component = new TextEncoder().encode("component");
const encryptionKey = "provider-secret-test-key-with-more-than-thirty-two-characters";

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

async function workspace() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  return { workspaceId: setup.workspace.id, userId: setup.owner.id };
}

describe("installing workspace model plugins", () => {
  it("keeps multiple providers installed without disabling either one", async () => {
    const owner = await workspace();
    for (const [id, model] of [
      ["local.chat", "qwen3.5:2b"],
      ["cloud.chat", "gpt-4.1-mini"],
    ] as const) {
      await installWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "chat.complete",
        plugin: {
          manifest: manifest(id, "chat.complete"),
          component,
          configuration: { model },
        },
      });
    }

    const installed = await listPluginInstallations(client(), owner);
    expect(installed.map((plugin) => [plugin.manifest.id, plugin.enabled])).toEqual([
      ["cloud.chat", true],
      ["local.chat", true],
    ]);
  });

  it("requires each provider plugin to hold its own declared secret", async () => {
    const owner = await workspace();
    const chat = await installWorkspaceModelPlugin(client(), {
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

    await expect(
      installWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        plugin: {
          manifest: manifest("cloud.embedding", "embedding.embed", { apiKey: true }),
          component,
          configuration: { model: "text-embedding-3-small" },
        },
      }),
    ).rejects.toMatchObject({ code: "secret_required" });

    const embedding = await installWorkspaceModelPlugin(client(), {
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

    for (const installation of [chat, embedding]) {
      await expect(
        listPluginSecretNames(client(), { ...owner, installationId: installation.id }),
      ).resolves.toEqual(["api_key"]);
    }
    const stored = await db.query<{ installation_id: string; value_sealed: string }>(
      "SELECT installation_id, value_sealed FROM plugin_installation_secrets",
    );
    expect(
      Object.fromEntries(
        stored.rows.map((row) => [
          row.installation_id,
          openSecret(row.value_sealed, encryptionKey),
        ]),
      ),
    ).toEqual({ [chat.id]: "sk-chat", [embedding.id]: "sk-embedding" });
  });

  it("keeps a stored secret when the same plugin changes model", async () => {
    const owner = await workspace();
    const cloudChat = {
      manifest: manifest("cloud.chat", "chat.complete", { apiKey: true }),
      component,
    };
    const first = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        ...cloudChat,
        configuration: { model: "gpt-4.1-mini" },
        secrets: { api_key: "sk-chat" },
        encryptionKey,
      },
    });
    const second = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: { ...cloudChat, configuration: { model: "gpt-4.1" } },
    });

    expect(second).toMatchObject({ id: first.id, configuration: { model: "gpt-4.1" } });
    await expect(
      listPluginSecretNames(client(), { ...owner, installationId: first.id }),
    ).resolves.toEqual(["api_key"]);
  });

  it("rejects the wrong capability and an empty model without installing anything", async () => {
    const owner = await workspace();
    await expect(
      installWorkspaceModelPlugin(client(), {
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
      installWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        plugin: {
          manifest: manifest("local.embedding", "embedding.embed"),
          component,
          configuration: { model: " " },
        },
      }),
    ).rejects.toMatchObject({ code: "configuration_invalid" });
    expect(await listPluginInstallations(client(), owner)).toEqual([]);
  });
});
