import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listPluginInstallations: vi.fn(),
  loadModelSetup: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (operation: (client: object) => unknown) => operation({}),
}));
vi.mock("@doco/host", () => ({
  listPluginInstallations: mocks.listPluginInstallations,
}));
vi.mock("~/lib/model-setup.server", () => ({
  loadModelSetup: mocks.loadModelSetup,
}));
vi.mock("~/locales/catalog", () => ({ metaTranslator: vi.fn() }));

import { loader } from "./plugins";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadModelSetup.mockResolvedValue({
    isOwner: true,
    userId: "user_owner",
    workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    steps: [
      {
        kind: "chat",
        status: "ready",
        pluginId: "braino.openai-chat",
        pluginName: "OpenAI Chat",
        model: "gpt-4.1-mini",
      },
      {
        kind: "embedding",
        status: "ready",
        pluginId: "braino.openai-embedding",
        pluginName: "OpenAI Embeddings",
        model: "text-embedding-3-small",
      },
    ],
  });
  mocks.listPluginInstallations.mockResolvedValue([
    {
      id: "plugin_email",
      enabled: true,
      manifest: { id: "braino.resend", name: "Resend", capabilities: { "email.send": 1 } },
    },
    {
      id: "plugin_slack",
      enabled: true,
      manifest: { id: "braino.slack", name: "Slack", capabilities: { "chat.receive": 1 } },
    },
    {
      id: "plugin_old",
      enabled: false,
      manifest: { id: "braino.old-email", name: "Old email", capabilities: { "email.send": 1 } },
    },
  ]);
});

describe("plugin management", () => {
  it("groups model, email, and team-chat plugins without treating sources as plugins", async () => {
    const result = await loader({ request: new Request("https://meta.braino.dev/plugins") });

    expect(result.models.map((model) => model.kind)).toEqual(["chat", "embedding"]);
    expect(result.email?.manifest.id).toBe("braino.resend");
    expect(result.slack?.manifest.id).toBe("braino.slack");
    expect(mocks.listPluginInstallations).toHaveBeenCalledWith(
      {},
      { workspaceId: "workspace_meta", userId: "user_owner" },
    );
  });

  it("keeps plugin management owner-only", async () => {
    mocks.loadModelSetup.mockResolvedValue({
      isOwner: false,
      userId: "user_member",
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
      steps: [],
    });

    await expect(
      loader({ request: new Request("https://meta.braino.dev/plugins") }),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.listPluginInstallations).not.toHaveBeenCalled();
  });
});
