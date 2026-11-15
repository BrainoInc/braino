import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bundledModelProviderPlugins: vi.fn(),
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
  bundledModelProviderPlugins: mocks.bundledModelProviderPlugins,
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

describe("first-run workspace setup", () => {
  it("creates the workspace before asking the owner to choose model plugins", async () => {
    mocks.getSingleWorkspaceState.mockResolvedValue({ initialized: false });
    mocks.hashPassword.mockResolvedValue("scrypt$test");
    mocks.passwordError.mockReturnValue(null);
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
    expect(mocks.bundledModelProviderPlugins).not.toHaveBeenCalled();
    expect(mocks.installRequiredModelPlugins).not.toHaveBeenCalled();
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

  it("keeps provider internals out of workspace creation", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");
    const setup = source.slice(
      source.indexOf("function Setup"),
      source.indexOf("function ModelsRequired"),
    );

    expect(setup).not.toContain('name="chat_model"');
    expect(setup).not.toContain('name="embedding_model"');
    expect(setup).not.toContain('name="embedding_dimensions"');
    expect(setup).toContain("Step 1 of 2");
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

  it("installs an OpenAI chat and embedding pair from one API key", async () => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", "test-encryption-key-with-more-than-thirty-two-characters");
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
    mocks.bundledModelProviderPlugins.mockResolvedValue(bundledPlugins);
    mocks.installRequiredModelPlugins.mockResolvedValue({
      ready: true,
      chat: "ready",
      embedding: "ready",
    });

    const response = await action({
      request: new Request("https://meta.braino.dev/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "install_model_provider",
          provider: "openai",
          api_key: "sk-test-openai-key",
          chat_model: "gpt-4.1-mini",
          embedding_model: "text-embedding-3-small",
          embedding_dimensions: "1536",
        }),
      }),
    });

    expect(mocks.bundledModelProviderPlugins).toHaveBeenCalledWith("openai");
    expect(mocks.installRequiredModelPlugins).toHaveBeenCalledWith(
      {},
      {
        workspaceId: "workspace_meta",
        userId: "user_owner",
        chat: expect.objectContaining({
          configuration: { model: "gpt-4.1-mini" },
          secrets: { api_key: "sk-test-openai-key" },
        }),
        embedding: expect.objectContaining({
          configuration: { model: "text-embedding-3-small", dimensions: "1536" },
          secrets: { api_key: "sk-test-openai-key" },
        }),
      },
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected provider setup to redirect.");
    expect(response.headers.get("location")).toBe("/");
  });

  it("presents providers in human terms and keeps model IDs in advanced settings", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");
    const setup = source.slice(
      source.indexOf("function ModelsRequired"),
      source.indexOf("function SignIn"),
    );

    expect(setup).toContain("Power your Braino");
    expect(setup).toContain("Step 2 of 2");
    expect(setup).toContain('value="openai"');
    expect(setup).toContain('value="ollama"');
    expect(setup).toContain("Use your existing OpenAI API account");
    expect(setup).toContain("one to answer questions and one to make your workspace searchable");
    expect(setup).toContain("stores it encrypted and never displays it");
    expect(setup).toContain("Keep prompts and search local");
    expect(setup).toContain("<details");
    expect(setup).toContain("Advanced settings");
  });
});
