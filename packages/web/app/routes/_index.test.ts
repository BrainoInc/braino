import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledOllamaModelPlugins: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceModelPluginReadiness: vi.fn(),
  initializeSingleWorkspace: vi.fn(),
  installRequiredModelPlugins: vi.fn(),
  hashPassword: vi.fn(),
  passwordError: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  clearPasswordSignInAttempts: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceModelPluginReadiness: mocks.getWorkspaceModelPluginReadiness,
  initializeSingleWorkspace: mocks.initializeSingleWorkspace,
  installRequiredModelPlugins: mocks.installRequiredModelPlugins,
  reservePasswordSignInAttempt: vi.fn(),
  revokeUserSessions: vi.fn(),
}));
vi.mock("~/lib/bundled-model-plugins.server", () => ({
  bundledOllamaModelPlugins: mocks.bundledOllamaModelPlugins,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/password.server", () => ({
  hashPassword: mocks.hashPassword,
  passwordError: mocks.passwordError,
  verifyPassword: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({
  clearSessionCookie: vi.fn(),
  createSessionCookie: () => "doco_session=test; Path=/",
}));
vi.mock("~/lib/setup-token.server", () => ({ setupTokenError: () => null }));
vi.mock("~/lib/sign-in.server", () => ({ passwordAttemptBuckets: vi.fn() }));

import { action, loader } from "./_index";

const bundledPlugins = {
  chat: {
    manifest: { id: "braino.ollama-chat", capabilities: ["chat.complete"] },
    component: new Uint8Array([1]),
  },
  embedding: {
    manifest: { id: "braino.ollama-embedding", capabilities: ["embedding.embed"] },
    component: new Uint8Array([2]),
  },
};

describe("first-run setup password", () => {
  it("creates the workspace from one password field", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.hashPassword.mockResolvedValue("scrypt$test");
    mocks.passwordError.mockReturnValue(null);
    mocks.bundledOllamaModelPlugins.mockResolvedValue(bundledPlugins);
    mocks.initializeSingleWorkspace.mockResolvedValue({
      owner: { id: "user_owner", stamp: "stamp_owner" },
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    });
    const body = new URLSearchParams({
      intent: "setup",
      workspace_name: "Meta Braino",
      workspace_handle: "meta-braino",
      owner_name: "Owner",
      owner_username: "owner",
      owner_email: "owner@example.com",
      setup_token: "valid-setup-token",
      password: "generated-password-123",
      chat_model: "qwen3.5:2b",
      embedding_model: "embeddinggemma-2:270m",
      embedding_dimensions: "768",
    });

    const response = await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(mocks.hashPassword).toHaveBeenCalledWith("generated-password-123");
    expect(mocks.initializeSingleWorkspace).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ ownerPasswordHash: "scrypt$test" }),
    );
    expect(mocks.installRequiredModelPlugins).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        chat: expect.objectContaining({
          manifest: bundledPlugins.chat.manifest,
          configuration: { model: "qwen3.5:2b" },
        }),
        embedding: expect.objectContaining({
          manifest: bundledPlugins.embedding.manifest,
          configuration: { model: "embeddinggemma-2:270m", dimensions: "768" },
        }),
      },
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected setup to redirect.");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
  });

  it("returns validation failures as inline action data", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.passwordError.mockReturnValue("Use at least 12 characters.");
    const body = new URLSearchParams({
      intent: "setup",
      setup_token: "valid-setup-token",
      password: "short",
    });

    const result = await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(result).toEqual({ error: "Use at least 12 characters." });
    expect(mocks.hashPassword).not.toHaveBeenCalled();
  });

  it("preserves password characters exactly", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.hashPassword.mockResolvedValue("scrypt$test");
    mocks.passwordError.mockReturnValue(null);
    mocks.bundledOllamaModelPlugins.mockResolvedValue(bundledPlugins);
    mocks.initializeSingleWorkspace.mockResolvedValue({
      owner: { id: "user_owner", stamp: "stamp_owner" },
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    });
    const password = "  generated password 123  ";
    const body = new URLSearchParams({
      intent: "setup",
      workspace_name: "Meta Braino",
      workspace_handle: "meta-braino",
      owner_name: "Owner",
      owner_username: "owner",
      owner_email: "owner@example.com",
      setup_token: "valid-setup-token",
      password,
      chat_model: "qwen3.5:2b",
      embedding_model: "embeddinggemma-2:270m",
      embedding_dimensions: "768",
    });

    await action({
      request: new Request("https://meta.braino.dev/?index", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    });

    expect(mocks.passwordError).toHaveBeenCalledWith(password, expect.any(Function));
    expect(mocks.hashPassword).toHaveBeenCalledWith(password);
  });

  it("renders one password-manager-friendly setup field", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");

    expect(source).toContain('name="password"');
    expect(source).toContain('autoComplete="new-password"');
    expect(source).toContain("maxLength={200}");
    expect(source).not.toContain("password_confirmation");
    expect(source).not.toContain("Confirm password");
  });

  it("requires both model plugin configurations in first-run setup", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");

    expect(source).toContain('name="chat_model"');
    expect(source).toContain('name="embedding_model"');
    expect(source).toContain('name="embedding_dimensions"');
  });
});

describe("model plugin readiness gate", () => {
  it("keeps an initialized workspace out of the dashboard until both plugins are ready", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({
      initialized: true,
      workspace: { id: "workspace_meta", handle: "meta-braino", name: "Meta Braino" },
    });
    mocks.getCurrentUser.mockResolvedValue({
      id: "user_owner",
      email: "owner@example.com",
      username: "owner",
      name: "Owner",
    });
    mocks.getWorkspaceModelPluginReadiness.mockResolvedValue({
      ready: false,
      chat: "missing",
      embedding: "ready",
    });

    await expect(loader({ request: new Request("https://meta.braino.dev/") })).resolves.toEqual({
      screen: "models-required",
      workspaceName: "Meta Braino",
      chat: "missing",
      embedding: "ready",
    });
  });
});
