import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledPlugin: vi.fn(),
  connectWorkspaceTeamChatPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  verifySlackGatewayState: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  connectWorkspaceTeamChatPlugin: mocks.connectWorkspaceTeamChatPlugin,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({ bundledPlugin: mocks.bundledPlugin }));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));
vi.mock("~/lib/slack-gateway-state.server", () => ({
  brainoPluginGatewayUrl: () => "https://plugins.braino.dev",
  verifySlackGatewayState: mocks.verifySlackGatewayState,
}));

import { loader } from "./integrations.slack-app.callback";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("BRAINO_PLUGIN_GATEWAY_URL", "https://plugins.braino.dev");
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", email: "owner@example.com" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.getWorkspaceRole.mockResolvedValue("owner");
  mocks.pluginSecretsKey.mockReturnValue("instance-state-secret");
  mocks.pluginHostConnection.mockReturnValue({ url: "http://plugin-host:8080", apiToken: "x" });
  mocks.verifySlackGatewayState.mockReturnValue({
    userId: "user_owner",
    workspaceId: "workspace_meta",
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
      channels: [],
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        installationId: "installation_gateway",
        gatewaySecret: "scoped-gateway-secret",
        externalWorkspaceId: "T1",
        workspaceName: "Acme",
      }),
    ),
  );
});

describe("Slack gateway callback", () => {
  it("installs the gateway client with no Slack credential in the instance", async () => {
    const response = (await loader({
      request: new Request(
        "https://meta.braino.dev/integrations/slack-app/callback?code=one-time&state=local-state",
      ),
    }).catch((error: Response) => error)) as Response;

    expect(fetch).toHaveBeenCalledWith(
      "https://plugins.braino.dev/v1/installations/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "one-time" }),
      }),
    );
    expect(mocks.connectWorkspaceTeamChatPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        userId: "user_owner",
        configuration: {
          gateway_url: "https://plugins.braino.dev",
          installation_id: "installation_gateway",
        },
        secrets: { gateway_secret: "scoped-gateway-secret" },
        connectionInput: {},
      }),
    );
    const installInput = mocks.connectWorkspaceTeamChatPlugin.mock.calls[0]?.[1];
    expect(JSON.stringify(installInput)).not.toContain("xoxb-");
    expect(JSON.stringify(installInput)).not.toContain("signing_secret");
    expect(response.headers.get("location")).toBe("/integrations/slack-app?connected=1");
  });
});
