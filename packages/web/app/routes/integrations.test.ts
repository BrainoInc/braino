import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectConnector: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  syncConnectorConnection: vi.fn(),
}));

vi.mock("@braino/connector-plugins", () => ({
  connectorPlugin: () => ({ adapter: { provider: "slack" }, label: "Slack" }),
}));
vi.mock("@braino/db", () => ({
  withClient: (operation: (client: object) => unknown) => operation({}),
}));
vi.mock("@braino/host", () => ({
  connectConnector: mocks.connectConnector,
  createIncomingWebhook: vi.fn(),
  disconnectConnector: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  listConnectorConnections: vi.fn(),
  listGithubConnections: vi.fn(),
  listIncomingWebhooks: vi.fn(),
  listPluginInstallations: vi.fn(),
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
  mocks.connectConnector.mockResolvedValue({
    id: "connector_slack",
    sourceName: "Meta Slack",
  });
  mocks.syncConnectorConnection.mockResolvedValue({ created: 12 });
});

describe("built-in connector setup", () => {
  it("encrypts the Slack import token in this Braino instance without using the chat gateway", async () => {
    await action({
      request: new Request("https://meta.braino.dev/integrations", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "connect_slack", bot_token: "xoxb-meta-import" }),
      }),
    });

    expect(mocks.connectConnector).toHaveBeenCalledWith(expect.any(Function), {
      workspaceId: "workspace_meta",
      userId: "user_owner",
      credential: "xoxb-meta-import",
      encryptionKey: "integration-key-with-more-than-thirty-two-characters",
      adapter: { provider: "slack" },
    });
  });
});
