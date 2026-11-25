import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectGithubRepositoryWithPlugin: vi.fn(),
  createPluginGatewayState: vi.fn(),
  finishGithubGatewayMigration: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listGithubConnections: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  repositories: vi.fn(),
  resolveWorkspaceGithubPlugin: vi.fn(),
  syncGithubConnection: vi.fn(),
}));

vi.mock("@braino/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@braino/host", () => ({
  connectGithubRepositoryWithPlugin: mocks.connectGithubRepositoryWithPlugin,
  finishGithubGatewayMigration: mocks.finishGithubGatewayMigration,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listGithubConnections: mocks.listGithubConnections,
  resolveWorkspaceGithubPlugin: mocks.resolveWorkspaceGithubPlugin,
  syncGithubConnection: mocks.syncGithubConnection,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));
vi.mock("~/lib/plugin-gateway-state.server", () => ({
  brainoPluginGatewayUrl: () => "https://plugins.braino.dev",
  createPluginGatewayState: mocks.createPluginGatewayState,
}));

import { action, loader } from "./integrations.github-app";

const plugin = {
  installation: { installationId: "plugin_installation_github" },
  repositories: mocks.repositories,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", email: "owner@example.com" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.pluginSecretsKey.mockReturnValue("instance-state-secret");
  mocks.pluginHostConnection.mockReturnValue({ url: "http://plugin-host:8080", apiToken: "x" });
  mocks.resolveWorkspaceGithubPlugin.mockResolvedValue(null);
  mocks.listGithubConnections.mockResolvedValue([]);
  mocks.createPluginGatewayState.mockReturnValue("signed-instance-state");
  mocks.repositories.mockResolvedValue([{ fullName: "BrainoInc/braino", defaultBranch: "main" }]);
});

describe("Braino GitHub App setup", () => {
  it("leaves merge enforcement to GitHub instead of accepting an enforcement action", async () => {
    mocks.resolveWorkspaceGithubPlugin.mockResolvedValue(plugin);

    const result = await action({
      request: new Request("https://meta.braino.dev/integrations/github-app", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "enforcement",
          connection_id: "github_connection",
          required: "true",
        }),
      }),
    });

    expect(result).toEqual({ error: "Unsupported action." });
  });

  it("offers the official App installation without asking for a PAT", async () => {
    const result = await loader({
      request: new Request("https://meta.braino.dev/integrations/github-app"),
    });

    expect(result.installUrl).toBe(
      "https://plugins.braino.dev/v1/providers/github/install?callback_url=" +
        "https%3A%2F%2Fmeta.braino.dev%2Fintegrations%2Fgithub-app%2Fcallback&state=" +
        "signed-instance-state",
    );
    expect(mocks.createPluginGatewayState).toHaveBeenCalledWith(
      { provider: "github", userId: "user_owner", workspaceId: "workspace_meta" },
      "instance-state-secret",
    );
    expect(JSON.stringify(result)).not.toContain("access_token");
  });

  it("clears a legacy PAT only after the gateway sync succeeds", async () => {
    mocks.resolveWorkspaceGithubPlugin.mockResolvedValue(plugin);
    mocks.connectGithubRepositoryWithPlugin.mockResolvedValue({ id: "github_connection" });
    mocks.syncGithubConnection.mockResolvedValue({ created: 1, updated: 2, unchanged: 3 });

    const response = await action({
      request: new Request("https://meta.braino.dev/integrations/github-app", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "connect_repository", repository: "BrainoInc/braino" }),
      }),
    });

    expect(mocks.syncGithubConnection).toHaveBeenCalledWith(expect.any(Function), {
      connectionId: "github_connection",
      plugin,
      userId: "user_owner",
    });
    expect(mocks.finishGithubGatewayMigration).toHaveBeenCalledWith(expect.any(Function), {
      connectionId: "github_connection",
      pluginInstallationId: "plugin_installation_github",
    });
    expect(mocks.syncGithubConnection.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finishGithubGatewayMigration.mock.invocationCallOrder[0] ?? 0,
    );
    expect((response as Response).headers.get("location")).toBe(
      "/integrations/github-app?synced=1",
    );
  });

  it("preserves a legacy PAT when the first gateway sync fails", async () => {
    mocks.resolveWorkspaceGithubPlugin.mockResolvedValue(plugin);
    mocks.connectGithubRepositoryWithPlugin.mockResolvedValue({ id: "github_connection" });
    mocks.syncGithubConnection.mockRejectedValue(new Error("gateway unavailable"));

    const result = await action({
      request: new Request("https://meta.braino.dev/integrations/github-app", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "connect_repository", repository: "BrainoInc/braino" }),
      }),
    });

    expect(result).toEqual({ error: "gateway unavailable" });
    expect(mocks.finishGithubGatewayMigration).not.toHaveBeenCalled();
  });
});
