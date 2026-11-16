import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledPlugin: vi.fn(),
  connectWorkspaceTeamChatPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  resolveWorkspaceTeamChatPlugin: vi.fn(),
  send: vi.fn(),
  setPluginInstallationEnabled: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  connectWorkspaceTeamChatPlugin: mocks.connectWorkspaceTeamChatPlugin,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listPluginInstallations: vi.fn().mockResolvedValue([]),
  resolveWorkspaceTeamChatPlugin: mocks.resolveWorkspaceTeamChatPlugin,
  setPluginInstallationEnabled: mocks.setPluginInstallationEnabled,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({
  bundledPlugin: mocks.bundledPlugin,
}));
vi.mock("~/lib/current-user.server", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { action } from "./integrations.slack-app";

function post(fields: Record<string, string>) {
  return new Request("https://meta.braino.dev/integrations/slack-app", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({
    id: "user_owner",
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
  });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.pluginSecretsKey.mockReturnValue("encryption-key-with-more-than-thirty-two-characters");
  mocks.pluginHostConnection.mockReturnValue({
    url: "http://plugin-host:8080",
    apiToken: "plugin-host-token-with-more-than-thirty-two-characters",
  });
  mocks.bundledPlugin.mockResolvedValue({
    manifest: { id: "braino.slack" },
    component: new Uint8Array([1, 2, 3]),
  });
  mocks.connectWorkspaceTeamChatPlugin.mockResolvedValue({
    installation: { id: "plugin_installation_slack" },
    connection: {
      externalWorkspaceId: "T1",
      workspaceName: "Acme",
      botUserId: "U_BOT",
      installerUserId: "U_OWNER",
      channels: [{ id: "C_GENERAL", name: "general" }],
    },
  });
  mocks.resolveWorkspaceTeamChatPlugin.mockResolvedValue({ send: mocks.send });
  mocks.send.mockResolvedValue({ externalId: "1700000000.000100" });
});

describe("Señor Braino Slack setup", () => {
  it("verifies the local plugin then introduces Señor Braino in Slack", async () => {
    const response = await action({
      request: post({
        intent: "connect",
        bot_token: "xoxb-secret",
        signing_secret: "signing-secret",
        introduction_channel: "general",
      }),
    });

    expect(mocks.connectWorkspaceTeamChatPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        userId: "user_owner",
        manifest: { id: "braino.slack" },
        secrets: { bot_token: "xoxb-secret", signing_secret: "signing-secret" },
        connectionInput: {
          installer: { email: "owner@example.com" },
          introductionChannel: "general",
        },
      }),
    );
    expect(mocks.send).toHaveBeenNthCalledWith(1, {
      target: { kind: "channel", id: "C_GENERAL" },
      text: expect.stringContaining("Señor Braino"),
    });
    expect(mocks.send).toHaveBeenNthCalledWith(2, {
      target: { kind: "user", id: "U_OWNER" },
      text: expect.stringContaining("Meta Braino"),
    });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("location")).toBe(
      "/integrations/slack-app?connected=1",
    );
  });

  it("disconnects only this workspace's Slack plugin", async () => {
    const response = await action({
      request: post({ intent: "disconnect", installation_id: "plugin_installation_slack" }),
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
