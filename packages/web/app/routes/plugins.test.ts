import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPluginEntry, ModelStep } from "~/lib/model-plugin-catalog";

const mocks = vi.hoisted(() => ({
  activateWorkspaceModelPlugin: vi.fn(),
  bundledModelPlugin: vi.fn(),
  bundledPlugin: vi.fn(),
  connectWorkspaceEmailPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  installWorkspaceModelPlugin: vi.fn(),
  listPluginInstallations: vi.fn(),
  loadModelSetup: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  removePluginInstallation: vi.fn(),
  verifyWorkspaceModelPlugin: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  PluginInstallationError: class PluginInstallationError extends Error {},
  connectWorkspaceEmailPlugin: mocks.connectWorkspaceEmailPlugin,
  listPluginInstallations: mocks.listPluginInstallations,
  removePluginInstallation: mocks.removePluginInstallation,
}));
vi.mock("@doco/host/model-plugins", () => ({
  ModelPluginVerificationError: class ModelPluginVerificationError extends Error {
    constructor(public readonly kind: "chat" | "embedding") {
      super("verification failed");
    }
  },
  activateWorkspaceModelPlugin: mocks.activateWorkspaceModelPlugin,
  installWorkspaceModelPlugin: mocks.installWorkspaceModelPlugin,
  verifyWorkspaceModelPlugin: mocks.verifyWorkspaceModelPlugin,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({
  bundledModelPlugin: mocks.bundledModelPlugin,
  bundledPlugin: mocks.bundledPlugin,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  loadModelSetup: mocks.loadModelSetup,
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { loader as pluginsLoader } from "./plugins";
import { action, loader } from "./plugins.$pluginId";

const entry = (
  id: string,
  name: string,
  kind: "chat" | "embedding",
  cloud = false,
): ModelPluginEntry => ({
  id,
  name,
  kind,
  networkHosts: cloud ? ["api.openai.com"] : ["ollama:11434"],
  local: !cloud,
  requiredSecrets: cloud ? ["api_key"] : [],
  defaultModel:
    kind === "chat"
      ? cloud
        ? "gpt-4.1-mini"
        : "qwen3.5:2b"
      : cloud
        ? "text-embedding-3-small"
        : "embeddinggemma-2:270m",
  suggestedModels:
    kind === "chat"
      ? [cloud ? "gpt-4.1-mini" : "qwen3.5:2b"]
      : [cloud ? "text-embedding-3-small" : "embeddinggemma-2:270m"],
});

const catalog = [
  entry("braino.ollama-chat", "Ollama chat", "chat"),
  entry("braino.ollama-embedding", "Ollama embeddings", "embedding"),
  entry("braino.openai-chat", "OpenAI chat", "chat", true),
  entry("braino.openai-embedding", "OpenAI embeddings", "embedding", true),
];

const step = (kind: "chat" | "embedding"): ModelStep => ({
  kind,
  status: "preselected",
  pluginId: `braino.ollama-${kind}`,
  pluginName: `Ollama ${kind}`,
  model: kind === "chat" ? "qwen3.5:2b" : "embeddinggemma-2:270m",
  usesDefault: true,
  usesOwnKey: false,
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

function installedModel(
  pluginId: string,
  kind: "chat" | "embedding",
  options: { active?: boolean; verified?: boolean } = {},
) {
  return {
    installationId: `installation_${pluginId}`,
    pluginId,
    name: pluginId,
    kind,
    active: options.active ?? false,
    verified: options.verified ?? true,
    configuration: {
      model: kind === "chat" ? "gpt-4.1-mini" : "text-embedding-3-small",
    },
    secretNames: ["api_key"],
  };
}

function request(path: string, fields?: Record<string, string>) {
  return new Request(
    `https://meta.braino.dev${path}`,
    fields
      ? {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields),
        }
      : undefined,
  );
}

function installation(id: string, enabled = true) {
  return {
    id: `installation_${id}`,
    manifest: { id, name: id, capabilities: {} },
    enabled,
    configuration: {},
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadModelSetup.mockResolvedValue(setup());
  mocks.listPluginInstallations.mockResolvedValue([]);
  mocks.getCurrentUser.mockResolvedValue({ email: "owner@example.com" });
  mocks.pluginSecretsKey.mockReturnValue(
    "test-encryption-key-with-more-than-thirty-two-characters",
  );
  mocks.pluginHostConnection.mockReturnValue({
    url: "http://plugin-host:8080",
    apiToken: "host-token",
  });
  mocks.bundledModelPlugin.mockImplementation(async (id: string) => {
    const found = catalog.find((candidate) => candidate.id === id);
    return found ? { entry: found, manifest: { id }, component: new Uint8Array([1]) } : null;
  });
  mocks.bundledPlugin.mockResolvedValue({
    manifest: { id: "braino.resend" },
    component: new Uint8Array([2]),
  });
  mocks.installWorkspaceModelPlugin.mockImplementation(
    async (_client: object, input: { capability: string }) => ({
      id: `installation_${input.capability}`,
    }),
  );
});

describe("Plugins", () => {
  it("keeps inactive model plugins in Installed while other disabled plugins stay hidden", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({ installed: [installedModel("braino.openai-chat", "chat")] }),
    );
    mocks.listPluginInstallations.mockResolvedValue([
      installation("braino.slack"),
      installation("braino.resend", false),
    ]);

    const browse = await pluginsLoader({ request: request("/plugins") });
    const installed = await pluginsLoader({ request: request("/plugins?view=installed") });

    expect(browse.plugins.map((plugin) => plugin.id)).toEqual([
      "ollama-chat",
      "ollama-embedding",
      "openai-chat",
      "openai-embedding",
      "slack",
      "resend",
    ]);
    expect(installed.plugins.map((plugin) => plugin.id)).toEqual(["openai-chat", "slack"]);
    expect(installed.plugins[0]).toMatchObject({ installed: true, active: false });
  });

  it("presents OpenAI chat as one plugin with one model and one key", async () => {
    const data = await loader({
      request: request("/plugins/openai-chat"),
      params: { pluginId: "openai-chat" },
    });

    expect(data).toMatchObject({
      type: "model",
      id: "openai-chat",
      installed: false,
      setting: { kind: "chat", model: "gpt-4.1-mini", requiredSecrets: ["api_key"] },
    });
  });

  it("installs chat and embeddings separately with different OpenAI keys", async () => {
    const chatResponse = await action({
      request: request("/plugins/openai-chat", {
        intent: "save",
        model: "gpt-4.1-mini",
        api_key: "sk-chat-key",
      }),
      params: { pluginId: "openai-chat" },
    });
    const embeddingResponse = await action({
      request: request("/plugins/openai-embedding", {
        intent: "save",
        model: "text-embedding-3-small",
        api_key: "sk-embedding-key",
      }),
      params: { pluginId: "openai-embedding" },
    });

    expect(mocks.installWorkspaceModelPlugin.mock.calls.map(([, input]) => input)).toEqual([
      expect.objectContaining({
        capability: "chat.complete",
        plugin: expect.objectContaining({ secrets: { api_key: "sk-chat-key" } }),
      }),
      expect.objectContaining({
        capability: "embedding.embed",
        plugin: expect.objectContaining({ secrets: { api_key: "sk-embedding-key" } }),
      }),
    ]);
    expect(
      mocks.verifyWorkspaceModelPlugin.mock.calls.map(([, input]) => [
        input.capability,
        input.installationId,
      ]),
    ).toEqual([
      ["chat.complete", "installation_chat.complete"],
      ["embedding.embed", "installation_embedding.embed"],
    ]);
    expect(
      mocks.activateWorkspaceModelPlugin.mock.calls.map(([, input]) => input.capability),
    ).toEqual(["chat.complete", "embedding.embed"]);
    expect((chatResponse as Response).headers.get("location")).toBe("/plugins/openai-chat?saved=1");
    expect((embeddingResponse as Response).headers.get("location")).toBe(
      "/plugins/openai-embedding?saved=1",
    );
  });

  it("installs and verifies an alternative without replacing the active Chat plugin", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        ready: true,
        installed: [installedModel("braino.ollama-chat", "chat", { active: true })],
      }),
    );

    await action({
      request: request("/plugins/openai-chat", {
        intent: "save",
        model: "gpt-4.1-mini",
        api_key: "sk-chat-key",
      }),
      params: { pluginId: "openai-chat" },
    });

    expect(mocks.installWorkspaceModelPlugin).toHaveBeenCalledOnce();
    expect(mocks.verifyWorkspaceModelPlugin).toHaveBeenCalledOnce();
    expect(mocks.activateWorkspaceModelPlugin).not.toHaveBeenCalled();
  });

  it("makes a verified installed plugin active only when its owner asks", async () => {
    mocks.loadModelSetup.mockResolvedValue(
      setup({
        ready: true,
        installed: [
          installedModel("braino.ollama-chat", "chat", { active: true }),
          installedModel("braino.openai-chat", "chat"),
        ],
      }),
    );

    const response = await action({
      request: request("/plugins/openai-chat", { intent: "activate" }),
      params: { pluginId: "openai-chat" },
    });

    expect(mocks.activateWorkspaceModelPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        capability: "chat.complete",
        installationId: "installation_braino.openai-chat",
      }),
    );
    expect((response as Response).headers.get("location")).toBe("/plugins/openai-chat?saved=1");
  });

  it("removes only the selected model plugin", async () => {
    mocks.listPluginInstallations.mockResolvedValue([
      installation("braino.ollama-chat"),
      installation("braino.ollama-embedding"),
      installation("braino.slack"),
    ]);

    await action({
      request: request("/plugins/ollama-chat", { intent: "remove" }),
      params: { pluginId: "ollama-chat" },
    });

    expect(
      mocks.removePluginInstallation.mock.calls.map(([, input]) => input.installationId),
    ).toEqual(["installation_braino.ollama-chat"]);
  });

  it("uses the plugin URL as Slack's return address", async () => {
    const data = await loader({
      request: request("/plugins/slack"),
      params: { pluginId: "slack" },
    });

    expect(data.type).toBe("slack");
    if (data.type !== "slack") throw new Error("Expected Slack.");
    expect(data.installUrl).toContain(
      encodeURIComponent("https://meta.braino.dev/plugins/slack/callback"),
    );
  });

  it("installs Resend from its own app page", async () => {
    const response = await action({
      request: request("/plugins/resend", {
        intent: "connect",
        sender: "Braino <hello@braino.dev>",
        api_key: "re_test",
        verification_recipient: "owner@example.com",
      }),
      params: { pluginId: "resend" },
    });

    expect(mocks.connectWorkspaceEmailPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        configuration: { sender: "Braino <hello@braino.dev>" },
        secrets: { api_key: "re_test" },
        verificationRecipient: "owner@example.com",
      }),
    );
    expect((response as Response).headers.get("location")).toBe("/plugins/resend?saved=1");
  });
});
