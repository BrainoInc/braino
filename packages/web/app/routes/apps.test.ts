import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPluginEntry, ModelStep } from "~/lib/model-plugin-catalog";

const mocks = vi.hoisted(() => ({
  assignWorkspaceModelPlugins: vi.fn(),
  bundledModelPlugin: vi.fn(),
  bundledPlugin: vi.fn(),
  connectWorkspaceEmailPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  listPluginInstallations: vi.fn(),
  loadModelSetup: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  removePluginInstallation: vi.fn(),
  verifyWorkspaceModelPlugins: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  ModelPluginVerificationError: class ModelPluginVerificationError extends Error {
    constructor(public readonly kind: "chat" | "embedding") {
      super("verification failed");
    }
  },
  PluginInstallationError: class PluginInstallationError extends Error {},
  assignWorkspaceModelPlugins: mocks.assignWorkspaceModelPlugins,
  connectWorkspaceEmailPlugin: mocks.connectWorkspaceEmailPlugin,
  listPluginInstallations: mocks.listPluginInstallations,
  removePluginInstallation: mocks.removePluginInstallation,
  verifyWorkspaceModelPlugins: mocks.verifyWorkspaceModelPlugins,
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

import { loader as appsLoader } from "./apps";
import { action, loader } from "./apps.$appId";

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
});

describe("Apps", () => {
  it("shows Browse and limits Installed to apps enabled for this workspace", async () => {
    mocks.listPluginInstallations.mockResolvedValue([
      installation("braino.slack"),
      installation("braino.resend", false),
    ]);

    const browse = await appsLoader({ request: request("/apps") });
    const installed = await appsLoader({ request: request("/apps?view=installed") });

    expect(browse.apps.map((app) => app.id)).toEqual(["ollama", "openai", "slack", "resend"]);
    expect(installed.apps.map((app) => app.id)).toEqual(["slack"]);
  });

  it("presents one OpenAI app with chat and search settings", async () => {
    const data = await loader({ request: request("/apps/openai"), params: { appId: "openai" } });

    expect(data).toMatchObject({ type: "ai", id: "openai", installed: false });
    if (data.type !== "ai") throw new Error("Expected an AI app.");
    expect(data.settings.map((setting) => [setting.kind, setting.model])).toEqual([
      ["chat", "gpt-4.1-mini"],
      ["embedding", "text-embedding-3-small"],
    ]);
  });

  it("installs and verifies both capabilities from one OpenAI form", async () => {
    const response = await action({
      request: request("/apps/openai", {
        intent: "save",
        chat_model: "gpt-4.1-mini",
        embedding_model: "text-embedding-3-small",
        api_key: "sk-one-app-key",
      }),
      params: { appId: "openai" },
    });

    expect(mocks.assignWorkspaceModelPlugins).toHaveBeenCalledTimes(1);
    const installed = mocks.assignWorkspaceModelPlugins.mock.calls[0]?.[1].plugins;
    expect(installed.map((input: { capability: string }) => input.capability)).toEqual([
      "chat.complete",
      "embedding.embed",
    ]);
    for (const input of installed) {
      expect(input.plugin.secrets).toEqual({ api_key: "sk-one-app-key" });
    }
    expect(mocks.verifyWorkspaceModelPlugins).toHaveBeenCalledOnce();
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("location")).toBe("/apps/openai?saved=1");
  });

  it("removes every capability owned by one app", async () => {
    mocks.listPluginInstallations.mockResolvedValue([
      installation("braino.ollama-chat"),
      installation("braino.ollama-embedding"),
      installation("braino.slack"),
    ]);

    await action({
      request: request("/apps/ollama", { intent: "remove" }),
      params: { appId: "ollama" },
    });

    expect(
      mocks.removePluginInstallation.mock.calls.map(([, input]) => input.installationId),
    ).toEqual(["installation_braino.ollama-chat", "installation_braino.ollama-embedding"]);
  });

  it("uses the app URL as Slack's return address", async () => {
    const data = await loader({ request: request("/apps/slack"), params: { appId: "slack" } });

    expect(data.type).toBe("slack");
    if (data.type !== "slack") throw new Error("Expected Slack.");
    expect(data.installUrl).toContain(
      encodeURIComponent("https://meta.braino.dev/apps/slack/callback"),
    );
  });

  it("installs Resend from its own app page", async () => {
    const response = await action({
      request: request("/apps/resend", {
        intent: "connect",
        sender: "Braino <hello@braino.dev>",
        api_key: "re_test",
        verification_recipient: "owner@example.com",
      }),
      params: { appId: "resend" },
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
    expect((response as Response).headers.get("location")).toBe("/apps/resend?saved=1");
  });
});
