import type { PoolClient } from "@doco/db";
import type { PluginCapabilityName, PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { removePluginInstallation } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  activateWorkspaceModelPlugin,
  installWorkspaceModelPlugin,
  listWorkspaceModelPlugins,
} from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

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
  return {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    component: new TextEncoder().encode("component"),
  };
}

async function verify(installationId: string, dimensions: number | null = null) {
  await db.query(
    `UPDATE plugin_installations
        SET verified_at = now(), verified_embedding_dimensions = $2
      WHERE id = $1`,
    [installationId, dimensions],
  );
}

describe("workspace model plugin selection", () => {
  it("keeps multiple verified chat plugins installed while exactly one is active", async () => {
    const owner = await fixture();
    const ollama = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("braino.ollama-chat", "chat.complete"),
        component: owner.component,
        configuration: { model: "qwen3.5:2b" },
      },
    });
    await verify(ollama.id);
    await activateWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      installationId: ollama.id,
    });

    const openai = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("braino.openai-chat", "chat.complete"),
        component: owner.component,
        configuration: { model: "gpt-4.1-mini" },
      },
    });
    await verify(openai.id);

    await expect(listWorkspaceModelPlugins(client(), owner.workspaceId)).resolves.toEqual([
      expect.objectContaining({
        installationId: ollama.id,
        pluginId: "braino.ollama-chat",
        capability: "chat.complete",
        active: true,
        verified: true,
      }),
      expect.objectContaining({
        installationId: openai.id,
        pluginId: "braino.openai-chat",
        capability: "chat.complete",
        active: false,
        verified: true,
      }),
    ]);
  });

  it("switches the active chat plugin without uninstalling or disabling either plugin", async () => {
    const owner = await fixture();
    const installations = [];
    for (const [id, model] of [
      ["braino.ollama-chat", "qwen3.5:2b"],
      ["braino.openai-chat", "gpt-4.1-mini"],
    ] as const) {
      const installed = await installWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "chat.complete",
        plugin: {
          manifest: manifest(id, "chat.complete"),
          component: owner.component,
          configuration: { model },
        },
      });
      await verify(installed.id);
      installations.push(installed);
    }
    const [ollama, openai] = installations;
    if (!ollama || !openai) throw new Error("Expected two installed Chat plugins.");

    await activateWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      installationId: ollama.id,
    });
    await activateWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      installationId: openai.id,
    });

    const selected = await listWorkspaceModelPlugins(client(), owner.workspaceId);
    expect(selected.map(({ pluginId, active }) => [pluginId, active])).toEqual([
      ["braino.ollama-chat", false],
      ["braino.openai-chat", true],
    ]);
    const stored = await db.query<{ enabled: boolean }>(
      "SELECT enabled FROM plugin_installations ORDER BY manifest->>'id'",
    );
    expect(stored.rows).toEqual([{ enabled: true }, { enabled: true }]);
  });

  it("does not activate an unverified plugin", async () => {
    const owner = await fixture();
    const installed = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "embedding.embed",
      plugin: {
        manifest: manifest("braino.ollama-embedding", "embedding.embed"),
        component: owner.component,
        configuration: { model: "embeddinggemma-2:270m" },
      },
    });

    await expect(
      activateWorkspaceModelPlugin(client(), {
        ...owner,
        capability: "embedding.embed",
        installationId: installed.id,
      }),
    ).rejects.toMatchObject({ code: "plugin_unverified" });
  });

  it("requires a replacement before removing the active plugin", async () => {
    const owner = await fixture();
    const installed = await installWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      plugin: {
        manifest: manifest("braino.ollama-chat", "chat.complete"),
        component: owner.component,
        configuration: { model: "qwen3.5:2b" },
      },
    });
    await verify(installed.id);
    await activateWorkspaceModelPlugin(client(), {
      ...owner,
      capability: "chat.complete",
      installationId: installed.id,
    });

    await expect(
      removePluginInstallation(client(), { ...owner, installationId: installed.id }),
    ).rejects.toMatchObject({ code: "active_plugin_removal" });
  });
});
