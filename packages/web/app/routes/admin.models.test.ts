import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPluginEntry, ModelStep } from "~/lib/model-plugin-catalog";

const mocks = vi.hoisted(() => ({
  assignWorkspaceModelPlugin: vi.fn(),
  bundledModelPlugin: vi.fn(),
  getWorkspaceModelPluginReadiness: vi.fn(),
  loadModelSetup: vi.fn(),
  pluginSecretsKey: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  PluginInstallationError: class PluginInstallationError extends Error {},
  assignWorkspaceModelPlugin: mocks.assignWorkspaceModelPlugin,
  getWorkspaceModelPluginReadiness: mocks.getWorkspaceModelPluginReadiness,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({
  bundledModelPlugin: mocks.bundledModelPlugin,
}));
vi.mock("~/lib/model-setup.server", () => ({
  loadModelSetup: mocks.loadModelSetup,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { loader as pluginsLoader } from "./admin.models.$model";
import { loader as pluginLoader, action as usePlugin } from "./admin.models.$model.$pluginId";
import { action as finish, loader as setupLoader } from "./admin.models._index";

const entry = (
  id: string,
  name: string,
  kind: "chat" | "embedding",
  overrides: Partial<ModelPluginEntry> = {},
): ModelPluginEntry => ({
  id,
  name,
  kind,
  networkHosts: ["ollama:11434"],
  local: true,
  requiredSecrets: [],
  defaultModel: kind === "chat" ? "qwen3.5:2b" : "embeddinggemma-2:270m",
  suggestedModels: [kind === "chat" ? "qwen3.5:2b" : "embeddinggemma-2:270m"],
  defaultDimensions: kind === "chat" ? null : "768",
  ...overrides,
});

const cloud = { networkHosts: ["api.openai.com"], local: false, requiredSecrets: ["api_key"] };
const catalog = [
  entry("braino.ollama-chat", "Ollama chat", "chat"),
  entry("braino.ollama-embedding", "Ollama embeddings", "embedding"),
  entry("braino.openai-chat", "OpenAI chat", "chat", {
    ...cloud,
    defaultModel: "gpt-4.1-mini",
    suggestedModels: ["gpt-4.1-mini", "gpt-4.1"],
  }),
  entry("braino.openai-embedding", "OpenAI embeddings", "embedding", {
    ...cloud,
    defaultModel: "text-embedding-3-small",
    suggestedModels: ["text-embedding-3-small", "text-embedding-3-large"],
    defaultDimensions: "1536",
  }),
];

const step = (kind: "chat" | "embedding", overrides: Partial<ModelStep> = {}): ModelStep => ({
  kind,
  status: "preselected",
  pluginId: `braino.ollama-${kind}`,
  pluginName: kind === "chat" ? "Ollama chat" : "Ollama embeddings",
  model: kind === "chat" ? "qwen3.5:2b" : "embeddinggemma-2:270m",
  usesDefault: true,
  usesOwnKey: false,
  ...overrides,
});

function setup(overrides: Record<string, unknown> = {}) {
  return {
    workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    userId: "user_owner",
    isOwner: true,
    ready: false,
    catalog,
    installed: [],
    steps: [step("chat"), step("embedding")],
    ...overrides,
  };
}

function post(path: string, fields: Record<string, string> = {}): Request {
  return new Request(`https://meta.braino.dev${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

const get = (path: string) => new Request(`https://meta.braino.dev${path}`);

function location(response: unknown): string | null {
  if (!(response instanceof Response)) throw new Error("Expected a redirect.");
  return response.headers.get("location");
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadModelSetup.mockResolvedValue(setup());
  mocks.pluginSecretsKey.mockReturnValue(
    "test-encryption-key-with-more-than-thirty-two-characters",
  );
  mocks.bundledModelPlugin.mockImplementation(async (id: string) => {
    const found = catalog.find((candidate) => candidate.id === id);
    return found
      ? { entry: found, manifest: { id }, component: new TextEncoder().encode(id) }
      : null;
  });
});

describe("model setup: check and finish", () => {
  it("shows a fresh workspace both models pre-selected", async () => {
    await expect(setupLoader({ request: get("/admin/models") })).resolves.toEqual({
      isOwner: true,
      ready: false,
      steps: [step("chat"), step("embedding")],
    });
  });

  it("installs what is still only pre-selected and continues into the app", async () => {
    mocks.getWorkspaceModelPluginReadiness.mockResolvedValue({
      ready: true,
      chat: "ready",
      embedding: "ready",
    });

    const response = await finish({ request: post("/admin/models") });

    expect(mocks.assignWorkspaceModelPlugin.mock.calls.map(([, input]) => input)).toEqual([
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        capability: "chat.complete",
        plugin: expect.objectContaining({
          manifest: { id: "braino.ollama-chat" },
          configuration: { model: "qwen3.5:2b" },
        }),
      },
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        capability: "embedding.embed",
        plugin: expect.objectContaining({
          manifest: { id: "braino.ollama-embedding" },
          configuration: { model: "embeddinggemma-2:270m", dimensions: "768" },
        }),
      },
    ]);
    expect(location(response)).toBe("/");
  });

  it("leaves a model the owner already configured exactly as it is", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        steps: [
          step("chat", {
            status: "ready",
            pluginId: "braino.openai-chat",
            pluginName: "OpenAI chat",
            model: "gpt-4.1",
            usesDefault: false,
            usesOwnKey: true,
          }),
          step("embedding"),
        ],
      }),
    );
    mocks.getWorkspaceModelPluginReadiness.mockResolvedValue({
      ready: true,
      chat: "ready",
      embedding: "ready",
    });

    const response = await finish({ request: post("/admin/models") });

    expect(mocks.assignWorkspaceModelPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.assignWorkspaceModelPlugin.mock.calls[0]?.[1]).toMatchObject({
      capability: "embedding.embed",
    });
    expect(location(response)).toBe("/");
  });

  it("stays on setup and names the model that is not ready", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        steps: [
          step("chat", { status: "invalid", pluginId: "braino.openai-chat" }),
          step("embedding", { status: "ready" }),
        ],
      }),
    );
    mocks.getWorkspaceModelPluginReadiness.mockResolvedValue({
      ready: false,
      chat: "invalid",
      embedding: "ready",
    });

    await expect(finish({ request: post("/admin/models") })).resolves.toEqual({
      error: "Configure the chat model first.",
    });
    expect(mocks.assignWorkspaceModelPlugin).not.toHaveBeenCalled();
  });

  it("lets only an owner finish setup", async () => {
    mocks.loadModelSetup.mockResolvedValue(setup({ isOwner: false, catalog: [] }));

    await expect(finish({ request: post("/admin/models") })).resolves.toEqual({
      error: "Only a workspace owner can set up models.",
    });
    expect(mocks.assignWorkspaceModelPlugin).not.toHaveBeenCalled();
  });
});

describe("model setup: the plugins of one model", () => {
  it("lists what comes with Braino apart from the marketplace", async () => {
    const data = await pluginsLoader({
      request: get("/admin/models/chat"),
      params: { model: "chat" },
    });

    expect(data.included.map((row) => [row.plugin.id, row.chosenModel, row.assigned])).toEqual([
      ["braino.ollama-chat", "qwen3.5:2b", false],
    ]);
    expect(data.marketplace.map((row) => [row.plugin.id, row.chosenModel])).toEqual([
      ["braino.openai-chat", null],
    ]);
  });

  it("knows only the chat model and the embedding model", async () => {
    await expect(
      pluginsLoader({ request: get("/admin/models/vision"), params: { model: "vision" } }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("model setup: one plugin's page", () => {
  const chatPage = { model: "chat", pluginId: "braino.openai-chat" };
  const embeddingPage = { model: "embedding", pluginId: "braino.openai-embedding" };

  it("starts from the plugin's own defaults and says what it replaces", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({ steps: [step("chat"), step("embedding", { status: "ready" })] }),
    );

    await expect(
      pluginLoader({ request: get("/admin/models/embedding/x"), params: embeddingPage }),
    ).resolves.toMatchObject({
      kind: "embedding",
      plugin: { id: "braino.openai-embedding" },
      model: "text-embedding-3-small",
      dimensions: "1536",
      storedSecrets: [],
      replaces: "Ollama embeddings",
    });
    await expect(
      pluginLoader({ request: get("/admin/models/chat/x"), params: chatPage }),
    ).resolves.toMatchObject({ dimensions: null, replaces: null });
  });

  it("refuses a plugin on the page of a model it does not provide", async () => {
    await expect(
      pluginLoader({
        request: get("/admin/models/embedding/braino.openai-chat"),
        params: { model: "embedding", pluginId: "braino.openai-chat" },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("assigns the chat plugin with its own key and leaves embeddings alone", async () => {
    const response = await usePlugin({
      request: post("/admin/models/chat/braino.openai-chat", {
        model: "gpt-4.1",
        secret_api_key: "sk-chat-only",
      }),
      params: chatPage,
    });

    expect(mocks.assignWorkspaceModelPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.assignWorkspaceModelPlugin).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        capability: "chat.complete",
        plugin: {
          manifest: { id: "braino.openai-chat" },
          component: new TextEncoder().encode("braino.openai-chat"),
          configuration: { model: "gpt-4.1" },
          secrets: { api_key: "sk-chat-only" },
          encryptionKey: "test-encryption-key-with-more-than-thirty-two-characters",
        },
      },
    );
    expect(location(response)).toBe("/admin/models");
  });

  it("takes a model typed under Another model, and the embedding dimensions", async () => {
    await usePlugin({
      request: post("/admin/models/embedding/braino.openai-embedding", {
        model: "__another",
        model_other: " text-embedding-4 ",
        dimensions: "2048",
        secret_api_key: "sk-embedding-only",
      }),
      params: embeddingPage,
    });

    expect(mocks.assignWorkspaceModelPlugin.mock.calls[0]?.[1]).toMatchObject({
      capability: "embedding.embed",
      plugin: {
        configuration: { model: "text-embedding-4", dimensions: "2048" },
        secrets: { api_key: "sk-embedding-only" },
      },
    });
  });

  it("asks for the plugin's own key, even when another plugin of the provider has one", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        installed: [
          {
            pluginId: "braino.openai-chat",
            name: "OpenAI chat",
            kind: "chat",
            enabled: true,
            configuration: { model: "gpt-4.1-mini" },
            secretNames: ["api_key"],
          },
        ],
      }),
    );

    await expect(
      usePlugin({
        request: post("/admin/models/embedding/braino.openai-embedding", {
          model: "text-embedding-3-small",
          dimensions: "1536",
        }),
        params: embeddingPage,
      }),
    ).resolves.toEqual({ error: "Enter this plugin's key." });
    expect(mocks.assignWorkspaceModelPlugin).not.toHaveBeenCalled();
  });

  it("keeps the key a plugin already holds when only its model changes", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        installed: [
          {
            pluginId: "braino.openai-chat",
            name: "OpenAI chat",
            kind: "chat",
            enabled: true,
            configuration: { model: "gpt-4.1-mini" },
            secretNames: ["api_key"],
          },
        ],
      }),
    );

    await usePlugin({
      request: post("/admin/models/chat/braino.openai-chat", { model: "gpt-4.1" }),
      params: chatPage,
    });

    expect(mocks.assignWorkspaceModelPlugin.mock.calls[0]?.[1].plugin).toEqual({
      manifest: { id: "braino.openai-chat" },
      component: new TextEncoder().encode("braino.openai-chat"),
      configuration: { model: "gpt-4.1" },
    });
  });

  it.each([
    [{ model: "__another", model_other: "  " }, "Enter a model name."],
    [
      { model: "text-embedding-3-small", dimensions: "0", secret_api_key: "sk" },
      "Embedding dimensions must be a positive integer.",
    ],
    [
      { model: "text-embedding-3-small", dimensions: "15.5", secret_api_key: "sk" },
      "Embedding dimensions must be a positive integer.",
    ],
  ])("returns what is wrong with the form as inline action data", async (fields, error) => {
    await expect(
      usePlugin({
        request: post("/admin/models/embedding/braino.openai-embedding", fields),
        params: embeddingPage,
      }),
    ).resolves.toEqual({ error });
    expect(mocks.assignWorkspaceModelPlugin).not.toHaveBeenCalled();
  });

  it("sends anyone who is not an owner back to the setup overview", async () => {
    mocks.loadModelSetup.mockResolvedValue(setup({ isOwner: false, catalog: [] }));

    const refused = await usePlugin({
      request: post("/admin/models/chat/braino.openai-chat", { model: "gpt-4.1" }),
      params: chatPage,
    }).catch((thrown: unknown) => thrown);

    expect(location(refused)).toBe("/admin/models");
    expect(mocks.assignWorkspaceModelPlugin).not.toHaveBeenCalled();
  });
});

describe("the three model setup screens", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  const overview = read("./admin.models._index.tsx");
  const plugins = read("./admin.models.$model.tsx");
  const plugin = read("./admin.models.$model.$pluginId.tsx");

  it("are organised by what Braino needs, then by plugin", () => {
    expect(overview).toContain("Set up your models");
    expect(overview).toContain("Check and finish");
    expect(overview).toContain("to={`/admin/models/${step.kind}`}");
    expect(plugins).toContain("Included with Braino");
    expect(plugins).toContain("From the marketplace");
    expect(plugins).toContain("to={`/admin/models/${kind}/${plugin.id}`}");
    expect(plugin).toContain("What this plugin can do");
    expect(plugin).toContain("Another model…");
    expect(plugin).toContain("Use this plugin");
  });

  it("ask for embedding dimensions and a key on the plugin's page only", () => {
    expect(plugin).toContain('name="dimensions"');
    expect(plugin).toContain('type="password"');
    expect(plugin).toContain('autoComplete="off"');
    for (const screen of [overview, plugins]) {
      expect(screen).not.toContain("<input");
      expect(screen).not.toContain("<select");
    }
  });

  it("use the app's own surfaces and controls", () => {
    for (const screen of [overview, plugins, plugin]) {
      expect(screen).toContain("neu-button");
      expect(screen).toContain("<Card");
      expect(screen).not.toMatch(/#[0-9a-f]{3,8}\b|oklch\(|style=/i);
    }
  });
});
