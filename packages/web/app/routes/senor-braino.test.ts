import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  listWorkspaceChatMessages: vi.fn(),
  pluginHostConnection: vi.fn(),
  pluginSecretsKey: vi.fn(),
  resolveWorkspaceChatProvider: vi.fn(),
  sendWorkspaceChatMessage: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  listWorkspaceChatMessages: mocks.listWorkspaceChatMessages,
  resolveWorkspaceChatProvider: mocks.resolveWorkspaceChatProvider,
  sendWorkspaceChatMessage: mocks.sendWorkspaceChatMessage,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: mocks.pluginHostConnection,
  pluginSecretsKey: mocks.pluginSecretsKey,
}));

import { action, loader } from "./senor-braino";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({ id: "user_owner", username: "owner" });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.listWorkspaceChatMessages.mockResolvedValue([]);
  mocks.pluginSecretsKey.mockReturnValue("encryption-key-with-at-least-32-characters");
  mocks.pluginHostConnection.mockReturnValue({
    url: "http://plugin-host:8080",
    apiToken: "plugin-host-token-with-at-least-32-characters",
  });
  mocks.resolveWorkspaceChatProvider.mockResolvedValue({ modelId: "plugin:test:chat" });
  mocks.sendWorkspaceChatMessage.mockResolvedValue({ answer: "The grounded answer." });
});

describe("in-app Señor Braino", () => {
  it("loads the signed-in person's workspace conversation", async () => {
    const messages = [{ id: "message_1", role: "assistant", text: "Hello", createdAt: "now" }];
    mocks.listWorkspaceChatMessages.mockResolvedValue(messages);

    await expect(
      loader({ request: new Request("https://meta.braino.dev/senor-braino") }),
    ).resolves.toMatchObject({ messages, workspace: { id: "workspace_meta" } });
    expect(mocks.listWorkspaceChatMessages).toHaveBeenCalledWith(
      {},
      { workspaceId: "workspace_meta", userId: "user_owner" },
    );
  });

  it("answers through the assigned workspace chat plugin", async () => {
    const response = await action({
      request: new Request("https://meta.braino.dev/senor-braino", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ question: "What changed today?" }),
      }),
    });

    expect(mocks.sendWorkspaceChatMessage).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        userId: "user_owner",
        question: "What changed today?",
        baseUrl: "https://meta.braino.dev",
        chat: { modelId: "plugin:test:chat" },
      }),
    );
    expect((response as Response).headers.get("location")).toBe("/senor-braino#latest");
  });
});
