import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledPlugin: vi.fn(),
  connectWorkspaceGithubPlugin: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceRole: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  verifyPluginGatewayState: vi.fn(),
}));

vi.mock("@braino/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@braino/host", () => ({
  connectWorkspaceGithubPlugin: mocks.connectWorkspaceGithubPlugin,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceRole: mocks.getWorkspaceRole,
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({ bundledPlugin: mocks.bundledPlugin }));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));
vi.mock("~/lib/plugin-gateway-state.server", () => ({
  brainoPluginGatewayUrl: () => "https://plugins.braino.dev",
  verifyPluginGatewayState: mocks.verifyPluginGatewayState,
}));

import { loader } from "./integrations.github-app.callback";

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
  mocks.verifyPluginGatewayState.mockReturnValue({
    userId: "user_owner",
    workspaceId: "workspace_meta",
  });
  mocks.bundledPlugin.mockResolvedValue({
    manifest: { id: "braino.github" },
    component: new Uint8Array([1, 2, 3]),
  });
  mocks.connectWorkspaceGithubPlugin.mockResolvedValue({
    installation: { id: "plugin_installation_github" },
    repositories: [{ fullName: "brainoinc/braino", defaultBranch: "main" }],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        installationId: "installation_gateway",
        gatewaySecret: "scoped-gateway-secret",
        provider: "github",
        externalAccountId: "1234",
        accountName: "BrainoInc",
      }),
    ),
  );
});

describe("GitHub gateway callback", () => {
  it("installs only the scoped gateway client in this Braino instance", async () => {
    const response = (await loader({
      request: new Request(
        "https://meta.braino.dev/integrations/github-app/callback?code=one-time&state=local-state",
      ),
    }).catch((error: Response) => error)) as Response;

    expect(mocks.verifyPluginGatewayState).toHaveBeenCalledWith(
      "local-state",
      "github",
      "instance-state-secret",
    );
    expect(fetch).toHaveBeenCalledWith(
      "https://plugins.braino.dev/v1/installations/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "one-time" }),
      }),
    );
    expect(mocks.connectWorkspaceGithubPlugin).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        userId: "user_owner",
        configuration: {
          gateway_url: "https://plugins.braino.dev",
          installation_id: "installation_gateway",
        },
        secrets: { gateway_secret: "scoped-gateway-secret" },
      }),
    );
    const installInput = mocks.connectWorkspaceGithubPlugin.mock.calls[0]?.[1];
    expect(JSON.stringify(installInput)).not.toContain("private_key");
    expect(JSON.stringify(installInput)).not.toContain("ghs_");
    expect(response.headers.get("location")).toBe("/integrations/github-app?connected=1");
  });
});
