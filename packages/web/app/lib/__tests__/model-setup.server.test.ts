import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledModelPluginCatalog: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceModelPluginReadiness: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listPluginInstallations: vi.fn(),
  listPluginSecretNames: vi.fn(),
  pluginHostConnectionFromEnv: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceModelPluginReadiness: mocks.getWorkspaceModelPluginReadiness,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listPluginInstallations: mocks.listPluginInstallations,
  listPluginSecretNames: mocks.listPluginSecretNames,
  pluginHostConnectionFromEnv: mocks.pluginHostConnectionFromEnv,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({
  bundledModelPluginCatalog: mocks.bundledModelPluginCatalog,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));

import { loadModelSetup, pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";

const request = new Request("https://meta.braino.dev/apps");

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
  });
  mocks.getWorkspaceModelPluginReadiness.mockResolvedValue({
    ready: false,
    chat: "ready",
    embedding: "missing",
  });
  mocks.bundledModelPluginCatalog.mockResolvedValue([]);
});

describe("the state every model setup screen starts from", () => {
  it("shows an owner each installed model plugin with the names of the secrets it holds", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("owner");
    mocks.listPluginInstallations.mockResolvedValue([
      {
        id: "plugin_installation_chat",
        manifest: {
          id: "braino.openai-chat",
          name: "OpenAI chat",
          capabilities: { "chat.complete": 1 },
        },
        configuration: { model: "gpt-4.1" },
        enabled: true,
      },
      {
        id: "plugin_installation_mail",
        manifest: { id: "acme.mail", name: "Mail", capabilities: { "email.send": 1 } },
        configuration: {},
        enabled: true,
      },
    ]);
    mocks.listPluginSecretNames.mockResolvedValue(["api_key"]);

    const setup = await loadModelSetup(request);

    expect(setup).toMatchObject({ isOwner: true, ready: false, userId: "user_owner" });
    expect(setup.installed).toEqual([
      {
        pluginId: "braino.openai-chat",
        name: "OpenAI chat",
        kind: "chat",
        enabled: true,
        configuration: { model: "gpt-4.1" },
        secretNames: ["api_key"],
      },
    ]);
    expect(mocks.listPluginSecretNames).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        installationId: "plugin_installation_chat",
      },
    );
    expect(setup.steps.map((step) => [step.kind, step.status, step.pluginName])).toEqual([
      ["chat", "ready", "OpenAI chat"],
      ["embedding", "missing", null],
    ]);
  });

  it("shows anyone else only whether each model is ready, without sending them back home", async () => {
    mocks.getWorkspaceRole.mockResolvedValue("reader");

    const setup = await loadModelSetup(request);

    expect(setup).toMatchObject({ isOwner: false, catalog: [], installed: [] });
    expect(setup.steps.map((step) => [step.status, step.pluginId])).toEqual([
      ["ready", null],
      ["missing", null],
    ]);
    expect(mocks.listPluginInstallations).not.toHaveBeenCalled();
    expect(mocks.bundledModelPluginCatalog).not.toHaveBeenCalled();
  });

  it("sends a visitor without a session home to sign in", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);

    const sent = await loadModelSetup(request).catch((thrown: unknown) => thrown);

    expect(sent).toBeInstanceOf(Response);
    expect((sent as Response).headers.get("location")).toBe("/");
  });

  it("offers a key for sealing secrets only when the deployment has a usable one", () => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", "short");
    expect(pluginSecretsKey()).toBeNull();
    vi.stubEnv("DOCO_ENCRYPTION_KEY", "test-encryption-key-with-more-than-thirty-two-characters");
    expect(pluginSecretsKey()).toBe("test-encryption-key-with-more-than-thirty-two-characters");
  });

  it("uses the deployment's private plugin host only with a usable token", () => {
    mocks.pluginHostConnectionFromEnv.mockReturnValue(null);
    expect(pluginHostConnection()).toBeNull();
    const connection = {
      url: "http://plugin-host:8080",
      apiToken: "test-plugin-host-token-with-more-than-thirty-two-characters",
      timeoutMs: 65_000,
    };
    mocks.pluginHostConnectionFromEnv.mockReturnValue(connection);
    expect(pluginHostConnection()).toEqual(connection);
    expect(mocks.pluginHostConnectionFromEnv).toHaveBeenLastCalledWith(process.env);
  });
});
