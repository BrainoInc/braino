import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverGithubGatewayWebhook: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  resolveWorkspaceGithubPlugin: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  deliverGithubGatewayWebhook: mocks.deliverGithubGatewayWebhook,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  resolveWorkspaceGithubPlugin: mocks.resolveWorkspaceGithubPlugin,
}));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { action } from "./api.v1.plugins.github.events";

function request(body = JSON.stringify({ repository: { full_name: "BrainoInc/braino" } })) {
  return new Request("https://meta.braino.dev/api/v1/plugins/github/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-braino-gateway-installation": "installation_gateway",
      "x-braino-gateway-timestamp": "1794800000",
      "x-braino-gateway-signature": "v0=signature",
    },
    body,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta" },
  });
  mocks.pluginHostConnection.mockReturnValue({
    url: "http://plugin-host:8080",
    apiToken: "plugin-host-token-with-more-than-thirty-two-characters",
  });
  mocks.pluginSecretsKey.mockReturnValue("encryption-key-with-more-than-thirty-two-characters");
  mocks.resolveWorkspaceGithubPlugin.mockResolvedValue({ installation: { installationId: "pi" } });
  mocks.deliverGithubGatewayWebhook.mockResolvedValue({
    event: "pull_request",
    synced: true,
    replayed: false,
    checked: true,
    created: 0,
    updated: 1,
    unchanged: 5,
  });
});

describe("GitHub gateway Events API", () => {
  it("verifies and applies the installation-scoped delivery before acknowledging it", async () => {
    const body = JSON.stringify({ repository: { full_name: "BrainoInc/braino" } });
    const response = await action({ request: request(body) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      event: "pull_request",
      synced: true,
      replayed: false,
      checked: true,
      created: 0,
      updated: 1,
      unchanged: 5,
    });
    expect(mocks.deliverGithubGatewayWebhook).toHaveBeenCalledWith(expect.any(Function), {
      plugin: { installation: { installationId: "pi" } },
      body,
      headers: expect.objectContaining({
        "x-braino-gateway-installation": "installation_gateway",
        "x-braino-gateway-signature": "v0=signature",
      }),
    });
  });

  it("does not accept events until this instance has a GitHub plugin", async () => {
    mocks.resolveWorkspaceGithubPlugin.mockResolvedValue(null);

    const response = await action({ request: request() });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "GitHub is not connected." });
  });
});
