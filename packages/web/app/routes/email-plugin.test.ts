import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledPlugin: vi.fn(),
  connectWorkspaceEmailPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  listPluginInstallations: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  setPluginInstallationEnabled: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  connectWorkspaceEmailPlugin: mocks.connectWorkspaceEmailPlugin,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
  listPluginInstallations: mocks.listPluginInstallations,
  setPluginInstallationEnabled: mocks.setPluginInstallationEnabled,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({ bundledPlugin: mocks.bundledPlugin }));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { action, loader } from "./integrations.email";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", email: "owner@example.com" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.listPluginInstallations.mockResolvedValue([]);
  mocks.pluginSecretsKey.mockReturnValue("encryption-key-with-more-than-thirty-two-characters");
  mocks.pluginHostConnection.mockReturnValue({
    url: "http://plugin-host:8080",
    apiToken: "plugin-host-token-with-more-than-thirty-two-characters",
  });
  mocks.bundledPlugin.mockResolvedValue({
    manifest: { id: "braino.resend" },
    component: new TextEncoder().encode("resend"),
  });
});

function post(fields: Record<string, string>) {
  return new Request("https://meta.braino.dev/integrations/email", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("email plugin setup", () => {
  it("shows the currently enabled provider without exposing secrets", async () => {
    mocks.listPluginInstallations.mockResolvedValue([
      {
        id: "plugin_resend",
        enabled: true,
        manifest: { id: "braino.resend", name: "Resend email", capabilities: { "email.send": 1 } },
        configuration: { sender: "Braino <hello@example.com>" },
      },
    ]);

    await expect(
      loader({ request: new Request("https://meta.braino.dev/integrations/email") }),
    ).resolves.toMatchObject({
      connected: true,
      installationId: "plugin_resend",
      providerName: "Resend email",
      sender: "Braino <hello@example.com>",
    });
  });

  it("installs Resend and explicitly sends a verification email", async () => {
    const response = await action({
      request: post({
        intent: "connect",
        sender: "Braino <hello@braino.dev>",
        api_key: "re_workspace",
        verification_recipient: "owner@example.com",
      }),
    });

    expect(mocks.connectWorkspaceEmailPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        userId: "user_owner",
        configuration: { sender: "Braino <hello@braino.dev>" },
        secrets: { api_key: "re_workspace" },
        verificationRecipient: "owner@example.com",
      }),
    );
    expect((response as Response).headers.get("location")).toBe("/integrations/email?connected=1");
  });

  it("disconnects only the workspace email provider", async () => {
    const response = await action({
      request: post({ intent: "disconnect", installation_id: "plugin_resend" }),
    });

    expect(mocks.setPluginInstallationEnabled).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        installationId: "plugin_resend",
        enabled: false,
      },
    );
    expect((response as Response).headers.get("location")).toBe(
      "/integrations/email?disconnected=1",
    );
  });
});
