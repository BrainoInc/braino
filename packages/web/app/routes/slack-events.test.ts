import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueTeamChatEvents: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  receive: vi.fn(),
  resolveWorkspaceTeamChatPlugin: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  enqueueTeamChatEvents: mocks.enqueueTeamChatEvents,
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  resolveWorkspaceTeamChatPlugin: mocks.resolveWorkspaceTeamChatPlugin,
}));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { action } from "./api.v1.plugins.slack.events";

function request(body = "signed slack body") {
  return new Request("https://meta.braino.dev/api/v1/plugins/slack/events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": "1794800000",
      "x-slack-signature": "v0=signature",
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
  mocks.resolveWorkspaceTeamChatPlugin.mockResolvedValue({
    installation: { installationId: "plugin_installation_slack" },
    receive: mocks.receive,
  });
  mocks.enqueueTeamChatEvents.mockResolvedValue({ created: 1, skipped: 0 });
});

describe("Slack Events API", () => {
  it("answers Slack's signed URL verification challenge through the plugin", async () => {
    mocks.receive.mockResolvedValue([
      {
        id: "challenge:abc",
        occurredAt: "2026-11-16T00:00:00.000Z",
        kind: "webhook.challenge",
        data: { challenge: "abc" },
      },
    ]);

    const response = await action({ request: request() });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "abc" });
    expect(mocks.receive).toHaveBeenCalledWith({
      body: "signed slack body",
      headers: expect.objectContaining({
        "x-slack-request-timestamp": "1794800000",
        "x-slack-signature": "v0=signature",
      }),
      receivedAt: expect.any(Number),
    });
    expect(mocks.enqueueTeamChatEvents).not.toHaveBeenCalled();
  });

  it("durably enqueues a canonical message before acknowledging Slack", async () => {
    const events = [
      {
        id: "Ev1",
        occurredAt: "2026-11-16T00:00:00.000Z",
        kind: "team_chat.message",
        data: { channelId: "C1", text: "What did we decide?" },
      },
    ];
    mocks.receive.mockResolvedValue(events);

    const response = await action({ request: request() });

    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.enqueueTeamChatEvents).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        installationId: "plugin_installation_slack",
        events,
      },
    );
  });

  it("does not accept events until this instance has a Slack plugin", async () => {
    mocks.resolveWorkspaceTeamChatPlugin.mockResolvedValue(null);

    const response = await action({ request: request() });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Slack is not connected." });
  });
});
