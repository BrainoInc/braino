import type { PoolClient } from "@doco/db";
import type { PluginManifest } from "@doco/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { resolveWorkspaceChatProvider } from "../plugin-chat-provider.js";
import { configurePluginInstallation, installPlugin } from "../plugin-installations.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import { activateWorkspaceModelPlugin } from "../workspace-model-plugins.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "plugin-chat-key-with-more-than-thirty-two-characters";
const apiToken = "plugin-host-token-with-more-than-thirty-two-characters";

const manifest: PluginManifest = {
  protocolVersion: 2,
  id: "braino.ollama-chat",
  name: "Ollama chat",
  version: "0.1.0",
  capabilities: { "chat.complete": 1 },
  permissions: { network: ["ollama:11434"] },
  configurationSchema: {
    type: "object",
    properties: { model: { type: "string" } },
    additionalProperties: false,
  },
};

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  const installation = await installPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    manifest,
    component: new TextEncoder().encode("ollama chat component"),
  });
  await configurePluginInstallation(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    installationId: installation.id,
    configuration: { model: "qwen3.5:2b" },
    secrets: {},
    encryptionKey,
  });
  await db.query("UPDATE plugin_installations SET verified_at = now() WHERE id = $1", [
    installation.id,
  ]);
  await activateWorkspaceModelPlugin(client(), {
    workspaceId: setup.workspace.id,
    userId: setup.owner.id,
    capability: "chat.complete",
    installationId: installation.id,
  });
  return { ...setup, installation };
}

describe("workspace chat plugin", () => {
  it("adapts the assigned workspace plugin to the canonical chat contract", async () => {
    const setup = await fixture();
    const fetcher = vi.fn(async () =>
      Response.json({
        outputJson: JSON.stringify({
          content: "Braino keeps shared project memory.",
          model: "ollama:qwen3.5:2b",
        }),
      }),
    ) as typeof fetch;

    const provider = await resolveWorkspaceChatProvider(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher,
    });

    expect(provider).not.toBeNull();
    expect(provider).toMatchObject({
      modelId: "plugin:braino.ollama-chat:qwen3.5:2b",
    });
    await expect(
      provider?.complete({ messages: [{ role: "user", content: "What is Braino?" }] }),
    ).resolves.toEqual({
      content: "Braino keeps shared project memory.",
      model: "ollama:qwen3.5:2b",
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    const envelope = JSON.parse(String(init.body));
    expect(envelope.capability).toBe("chat.complete");
    expect(JSON.parse(envelope.inputJson)).toEqual({
      messages: [{ role: "user", content: "What is Braino?" }],
    });
  });

  it("returns null when the workspace has no assigned chat plugin", async () => {
    const setup = await initializeSingleWorkspace(client(), {
      workspaceHandle: "empty",
      workspaceName: "Empty",
      ownerEmail: "owner@example.com",
      ownerUsername: "owner",
      ownerName: "Owner",
      ownerPasswordHash: "scrypt$salt$key",
    });

    await expect(
      resolveWorkspaceChatProvider(client(), {
        workspaceId: setup.workspace.id,
        encryptionKey,
        host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      }),
    ).resolves.toBeNull();
  });

  it("rejects malformed plugin output at the shared contract boundary", async () => {
    const setup = await fixture();
    const provider = await resolveWorkspaceChatProvider(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      host: { url: "http://plugin-host:8080", apiToken, timeoutMs: 65_000 },
      fetcher: vi.fn(async () =>
        Response.json({
          outputJson: JSON.stringify({
            content: "",
            model: "ollama:qwen3.5:2b",
          }),
        }),
      ) as typeof fetch,
    });

    await expect(
      provider?.complete({ messages: [{ role: "user", content: "Unsafe output?" }] }),
    ).rejects.toMatchObject({ code: "plugin_output_invalid", status: 502 });
  });
});
