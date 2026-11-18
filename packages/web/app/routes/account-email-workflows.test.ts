import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptWorkspaceInvitation: vi.fn(),
  consumePasswordResetLink: vi.fn(),
  createPasswordResetLink: vi.fn(),
  createWorkspaceInvitation: vi.fn(),
  getCurrentUser: vi.fn(),
  getSingleWorkspaceState: vi.fn(),
  hashPassword: vi.fn(),
  passwordError: vi.fn(),
  providerSend: vi.fn(),
  resolveWorkspaceEmailPlugin: vi.fn(),
  revokeWorkspaceInvitation: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  withClient: (callback: (client: object) => unknown) => callback({}),
}));
vi.mock("@doco/host", () => ({
  AccountLinkError: class AccountLinkError extends Error {},
  WorkspaceAccessError: class WorkspaceAccessError extends Error {},
  acceptWorkspaceInvitation: mocks.acceptWorkspaceInvitation,
  consumePasswordResetLink: mocks.consumePasswordResetLink,
  createPasswordResetLink: mocks.createPasswordResetLink,
  createWorkspaceInvitation: mocks.createWorkspaceInvitation,
  getPasswordResetLink: vi.fn(),
  getSingleWorkspaceState: mocks.getSingleWorkspaceState,
  getWorkspaceInvitation: vi.fn(),
  listWorkspaceCollaborators: vi.fn().mockResolvedValue([]),
  listWorkspaceInvitations: vi.fn().mockResolvedValue([]),
  removeWorkspaceCollaborator: vi.fn(),
  resolveWorkspaceEmailPlugin: mocks.resolveWorkspaceEmailPlugin,
  revokeWorkspaceInvitation: mocks.revokeWorkspaceInvitation,
  updateWorkspaceCollaborator: vi.fn(),
}));
vi.mock("~/lib/current-user.server", () => ({ getCurrentUser: mocks.getCurrentUser }));
vi.mock("~/lib/model-setup.server", () => ({
  pluginHostConnection: () => ({ url: "http://plugin-host:8080", apiToken: "host-token" }),
  pluginSecretsKey: () => "encryption-key",
}));
vi.mock("~/lib/password.server", () => ({
  hashPassword: mocks.hashPassword,
  passwordError: mocks.passwordError,
}));
vi.mock("~/lib/session.server", () => ({
  createSessionCookie: ({ userId }: { userId: string }) => `doco_session=${userId}; Path=/`,
}));
vi.mock("~/locales/catalog", () => ({
  metaTranslator: () => (value: string) => value,
  requestTranslator: async () => (value: string) => value,
}));

import { action as collaboratorAction } from "./collaborators";
import { action as forgotPasswordAction } from "./forgot-password";
import { action as invitationAction } from "./join.$token";
import { action as resetPasswordAction } from "./reset-password.$token";

function post(url: string, fields: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue({
    id: "user_owner",
    email: "owner@example.com",
    username: "owner",
    name: "Owner",
  });
  mocks.getSingleWorkspaceState.mockResolvedValue({
    initialized: true,
    workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
  });
  mocks.resolveWorkspaceEmailPlugin.mockResolvedValue({ send: mocks.providerSend });
  mocks.createWorkspaceInvitation.mockResolvedValue({
    id: "account_link_invite",
    token: "invite-secret",
    email: "writer@example.com",
    role: "writer",
    writeTypes: ["*"],
  });
  mocks.passwordError.mockReturnValue(null);
  mocks.hashPassword.mockResolvedValue("scrypt$new$key");
});

describe("emailed collaborator invitations", () => {
  it("emails a one-use join link instead of asking the owner to choose a password", async () => {
    const response = await collaboratorAction({
      request: post("https://meta.braino.dev/collaborators", {
        intent: "invite",
        email: "writer@example.com",
        role: "writer",
      }),
    });

    expect(mocks.createWorkspaceInvitation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        workspaceId: "workspace_meta",
        actorId: "user_owner",
        email: "writer@example.com",
        role: "writer",
      }),
    );
    expect(mocks.providerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["writer@example.com"],
        subject: "You're invited to Meta Braino on Braino",
        text: expect.stringContaining("https://meta.braino.dev/join/invite-secret"),
      }),
    );
    expect((response as Response).headers.get("location")).toBe("/collaborators?invited=1");
  });

  it("revokes an undelivered invitation", async () => {
    mocks.providerSend.mockRejectedValue(new Error("provider unavailable"));
    const result = await collaboratorAction({
      request: post("https://meta.braino.dev/collaborators", {
        intent: "invite",
        email: "writer@example.com",
        role: "reader",
      }),
    });

    expect(mocks.revokeWorkspaceInvitation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ invitationId: "account_link_invite" }),
    );
    expect(result).toMatchObject({ error: "provider unavailable" });
  });
});

describe("password recovery", () => {
  it("returns the same acknowledgement while emailing a real account", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.createPasswordResetLink.mockResolvedValue({
      token: "reset-secret",
      email: "owner@example.com",
      workspaceId: "workspace_meta",
      workspaceName: "Meta Braino",
    });

    const result = await forgotPasswordAction({
      request: post("https://meta.braino.dev/forgot-password", {
        email: "owner@example.com",
      }),
    });

    expect(result).toEqual({ submitted: true });
    expect(mocks.providerSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["owner@example.com"],
        subject: "Reset your Meta Braino password",
        text: expect.stringContaining("https://meta.braino.dev/reset-password/reset-secret"),
      }),
    );
  });

  it("does not reveal that an address has no account", async () => {
    mocks.getCurrentUser.mockResolvedValue(null);
    mocks.createPasswordResetLink.mockResolvedValue(null);

    await expect(
      forgotPasswordAction({
        request: post("https://meta.braino.dev/forgot-password", {
          email: "nobody@example.com",
        }),
      }),
    ).resolves.toEqual({ submitted: true });
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("accepts an invitation and signs in the new collaborator", async () => {
    mocks.acceptWorkspaceInvitation.mockResolvedValue({
      workspace: { id: "workspace_meta", handle: "meta", name: "Meta Braino" },
      user: {
        id: "user_writer",
        email: "writer@example.com",
        username: "writer",
        name: "Workspace Writer",
        stamp: "new-stamp",
      },
    });
    const response = await invitationAction({
      request: post("https://meta.braino.dev/join/invite-secret", {
        name: "Workspace Writer",
        username: "writer",
        password: "a sufficiently long password",
      }),
      params: { token: "invite-secret" },
    });

    expect(mocks.acceptWorkspaceInvitation).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ token: "invite-secret", passwordHash: "scrypt$new$key" }),
    );
    expect((response as Response).headers.get("set-cookie")).toContain("user_writer");
  });

  it("resets the password, revokes old sessions, and signs in the account", async () => {
    mocks.consumePasswordResetLink.mockResolvedValue({
      workspaceId: "workspace_meta",
      user: { id: "user_owner", email: "owner@example.com", stamp: "reset-stamp" },
    });
    const response = await resetPasswordAction({
      request: post("https://meta.braino.dev/reset-password/reset-secret", {
        password: "a sufficiently long replacement",
      }),
      params: { token: "reset-secret" },
    });

    expect(mocks.consumePasswordResetLink).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ token: "reset-secret", passwordHash: "scrypt$new$key" }),
    );
    expect((response as Response).headers.get("set-cookie")).toContain("user_owner");
  });
});
