import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  getWorkspaceModelPluginReadiness: vi.fn(),
  initializeSingleWorkspace: vi.fn(),
  hashPassword: vi.fn(),
  passwordError: vi.fn(),
}));

vi.mock("@braino/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@braino/host", () => ({
  clearPasswordSignInAttempts: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  initializeSingleWorkspace: mocks.initializeSingleWorkspace,
  reservePasswordSignInAttempt: vi.fn(),
}));
vi.mock("@braino/host/model-plugins", () => ({
  getWorkspaceModelPluginReadiness: mocks.getWorkspaceModelPluginReadiness,
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/password.server", () => ({
  hashPassword: mocks.hashPassword,
  passwordError: mocks.passwordError,
  verifyPassword: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  createSessionCookie: () => "braino_session=test; Path=/",
}));
vi.mock("~/lib/setup-token.server", () => ({ setupTokenError: () => null }));
vi.mock("~/lib/sign-in.server", () => ({ passwordAttemptBuckets: vi.fn() }));

import { action, loader } from "./_index";

describe("sign out", () => {
  it("ends only the current browser session", async () => {
    mocks.clearSessionCookie.mockReturnValue("braino_session=; Max-Age=0; Path=/");
    const response = await action({
      request: new Request("https://meta.braino.dev/", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "signout" }),
      }),
    });

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected sign out to redirect.");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(mocks.getSingleWorkspaceState).not.toHaveBeenCalled();
  });
});

describe("first-run workspace setup", () => {
  it("creates the workspace before asking the owner to install an AI app", async () => {
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
    const setup = source.slice(source.indexOf("function Setup"), source.indexOf("function SignIn"));

    expect(setup).not.toContain('name="chat_model"');
    expect(setup).not.toContain('name="embedding_model"');
    expect(setup).not.toContain('name="embedding_dimensions"');
    expect(setup).toContain("Step 1 of 2");
  });
});

describe("AI app readiness gate", () => {
  it("sends an initialized workspace to apps until one AI app is ready", async () => {
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

    const sent = await loader({ request: new Request("https://meta.braino.dev/") }).catch(
      (thrown: unknown) => thrown,
    );

    expect(sent).toBeInstanceOf(Response);
    if (!(sent instanceof Response)) throw new Error("Expected a redirect to model setup.");
    expect(sent.status).toBe(302);
    expect(sent.headers.get("location")).toBe("/plugins");
  });

  it("has no model form or install action of its own", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");

    expect(source).not.toContain("install_model_provider");
    expect(source).not.toContain("ModelsRequired");
    expect(source).not.toContain("api_key");
    expect(source).not.toContain("assignWorkspaceModelPlugin");
  });
});

describe("workspace homepage", () => {
  it("uses the hosted Braino Orbit experience instead of the legacy collection directory", () => {
    const source = readFileSync(new URL("./_index.tsx", import.meta.url), "utf8");
    const home = source.slice(source.indexOf("function WorkspaceHome"));

    expect(home).toContain("<Orbit");
    expect(home).toContain("range={data.range}");
    expect(home).not.toContain("Collections in this workspace");
  });
});
