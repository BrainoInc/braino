import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectConnector: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  resolveWorkspaceSlackGatewayCredential: vi.fn(),
  slackGatewayCredential: vi.fn(),
  syncConnectorConnection: vi.fn(),
}));

vi.mock("@doco/connector-plugins", () => ({
  connectorPlugin: () => ({ adapter: { provider: "slack" }, label: "Slack" }),
  slackGatewayCredential: mocks.slackGatewayCredential,
}));
vi.mock("@doco/db", () => ({
  withClient: (operation: (client: object) => unknown) => operation({}),
}));
vi.mock("@doco/host", () => ({
  connectConnector: mocks.connectConnector,
  createIncomingWebhook: vi.fn(),
  disconnectConnector: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  listConnectorConnections: vi.fn(),
  listGithubConnections: vi.fn(),
  listIncomingWebhooks: vi.fn(),
  listPluginInstallations: vi.fn(),
  resolveWorkspaceSlackGatewayCredential: mocks.resolveWorkspaceSlackGatewayCredential,
  revokeIncomingWebhook: vi.fn(),
  syncConnectorConnection: mocks.syncConnectorConnection,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/locales/catalog", () => ({
  metaTranslator: vi.fn(),
  requestTranslator: async () => (message: string) => message,
}));

import { action } from "./integrations";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("DOCO_ENCRYPTION_KEY", "integration-key-with-more-than-thirty-two-characters");
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta" },
  });
  mocks.resolveWorkspaceSlackGatewayCredential.mockResolvedValue({
    gatewayUrl: "https://plugins.braino.dev",
    installationId: "installation_meta",
    gatewaySecret: "scoped-meta-secret",
  });
  mocks.slackGatewayCredential.mockReturnValue("serialized-scoped-gateway-credential");
  mocks.connectConnector.mockResolvedValue({
    id: "connector_slack",
    sourceName: "Meta Slack",
  });
  mocks.syncConnectorConnection.mockResolvedValue({ created: 12 });
});

describe("built-in connector setup", () => {
  it("enables Slack import from the existing gateway binding without accepting a bot token", async () => {
    await action({
      request: new Request("https://meta.braino.dev/integrations", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "connect_slack", bot_token: "xoxb-must-be-ignored" }),
      }),
    });

    expect(mocks.slackGatewayCredential).toHaveBeenCalledWith({
      gatewayUrl: "https://plugins.braino.dev",
      installationId: "installation_meta",
      gatewaySecret: "scoped-meta-secret",
    });
    expect(mocks.connectConnector).toHaveBeenCalledWith(expect.any(Function), {
      workspaceId: "workspace_meta",
      userId: "user_owner",
      credential: "serialized-scoped-gateway-credential",
      encryptionKey: "integration-key-with-more-than-thirty-two-characters",
      adapter: { provider: "slack" },
    });
    expect(JSON.stringify(mocks.connectConnector.mock.calls)).not.toContain("xoxb-must-be-ignored");
  });
});
