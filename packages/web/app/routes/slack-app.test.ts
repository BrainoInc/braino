import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSlackGatewayState: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listPluginInstallations: vi.fn(),
  pluginSecretsKey: vi.fn(),
  setPluginInstallationEnabled: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listPluginInstallations: mocks.listPluginInstallations,
  setPluginInstallationEnabled: mocks.setPluginInstallationEnabled,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({ pluginSecretsKey: mocks.pluginSecretsKey }));
vi.mock("~/lib/slack-gateway-state.server", () => ({
  brainoPluginGatewayUrl: () => "https://plugins.braino.dev",
  createSlackGatewayState: mocks.createSlackGatewayState,
}));

import { action, loader } from "./integrations.slack-app";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRAINO_PLUGIN_GATEWAY_URL", "https://plugins.braino.dev");
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", email: "owner@example.com" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.listPluginInstallations.mockResolvedValue([]);
  mocks.pluginSecretsKey.mockReturnValue("instance-state-secret");
  mocks.createSlackGatewayState.mockReturnValue("signed-instance-state");
});

describe("Señor Braino Slack setup", () => {
  it("offers the official Marketplace install without asking for Slack credentials", async () => {
    const result = await loader({
      request: new Request("https://meta.braino.dev/integrations/slack-app"),
    });

    expect(result.connected).toBe(false);
    expect(result.installUrl).toBe(
      "https://plugins.braino.dev/v1/providers/slack/install?callback_url=" +
        "https%3A%2F%2Fmeta.braino.dev%2Fintegrations%2Fslack-app%2Fcallback&state=" +
        "signed-instance-state",
    );
    expect(mocks.createSlackGatewayState).toHaveBeenCalledWith(
      { userId: "user_owner", workspaceId: "workspace_meta" },
      "instance-state-secret",
    );
    expect(JSON.stringify(result)).not.toContain("bot_token");
    expect(JSON.stringify(result)).not.toContain("signing_secret");
  });

  it("disconnects only this workspace's gateway plugin", async () => {
    const response = await action({
      request: new Request("https://meta.braino.dev/integrations/slack-app", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "disconnect",
          installation_id: "plugin_installation_slack",
        }),
      }),
    });

    expect(mocks.setPluginInstallationEnabled).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        installationId: "plugin_installation_slack",
        enabled: false,
      },
    );
    expect((response as Response).headers.get("location")).toBe(
      "/integrations/slack-app?disconnected=1",
    );
  });
});
