import type { PoolClient } from "@braino/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  acceptWorkspaceInvitation,
  consumePasswordResetLink,
  createPasswordResetLink,
  createWorkspaceInvitation,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from "../account-links.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function initialized() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$owner$key",
  });
}

describe("workspace invitation links", () => {
  it("stores only a token digest and lets the recipient create their own account once", async () => {
    const setup = await initialized();
    const invitation = await createWorkspaceInvitation(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: " Writer@Example.com ",
      role: "writer",
      writeTypes: [],
    });

    expect(invitation).toMatchObject({
      email: "writer@example.com",
      role: "writer",
      writeTypes: ["*"],
    });
    const stored = await db.query<{ token_hash: string }>(
      "SELECT token_hash FROM account_links WHERE id = $1",
      [invitation.id],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toBe(invitation.token);

    const accepted = await acceptWorkspaceInvitation(client(), {
      token: invitation.token,
      username: "writer",
      name: "Workspace Writer",
      passwordHash: "scrypt$writer$key",
    });

    expect(accepted).toMatchObject({
      workspace: setup.workspace,
      user: {
        email: "writer@example.com",
        username: "writer",
        name: "Workspace Writer",
      },
    });
    const member = await db.query<{ role: string; write_types: string[] }>(
      "SELECT role, write_types FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [setup.workspace.id, accepted.user.id],
    );
    expect(member.rows[0]).toEqual({ role: "writer", write_types: ["*"] });
    await expect(
      acceptWorkspaceInvitation(client(), {
        token: invitation.token,
        username: "writer-again",
        name: "Writer Again",
        passwordHash: "scrypt$again$key",
      }),
    ).rejects.toMatchObject({ code: "account_link_invalid", status: 410 });
  });

  it("lists and revokes pending invitations without exposing their bearer tokens", async () => {
    const setup = await initialized();
    const invitation = await createWorkspaceInvitation(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: "reader@example.com",
      role: "reader",
      writeTypes: ["decision", "not-a-type"],
    });

    expect(await listWorkspaceInvitations(client(), setup.workspace.id)).toEqual([
      expect.objectContaining({
        id: invitation.id,
        email: "reader@example.com",
        role: "reader",
        writeTypes: ["decision"],
      }),
    ]);
    expect(
      JSON.stringify(await listWorkspaceInvitations(client(), setup.workspace.id)),
    ).not.toContain(invitation.token);

    await revokeWorkspaceInvitation(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      invitationId: invitation.id,
    });
    expect(await listWorkspaceInvitations(client(), setup.workspace.id)).toEqual([]);
  });

  it("requires an owner and rejects expired links", async () => {
    const setup = await initialized();
    await expect(
      createWorkspaceInvitation(client(), {
        workspaceId: setup.workspace.id,
        actorId: "user_not_owner",
        email: "blocked@example.com",
        role: "reader",
        writeTypes: [],
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });

    const now = new Date("2026-11-18T12:00:00.000Z");
    const invitation = await createWorkspaceInvitation(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      email: "late@example.com",
      role: "reader",
      writeTypes: [],
      now,
    });
    await expect(
      acceptWorkspaceInvitation(client(), {
        token: invitation.token,
        username: "late",
        name: "Late Person",
        passwordHash: "scrypt$late$key",
        now: new Date("2026-11-20T12:00:01.000Z"),
      }),
    ).rejects.toMatchObject({ code: "account_link_invalid", status: 410 });
  });
});

describe("password reset links", () => {
  it("does not mint links for unknown addresses", async () => {
    await initialized();
    await expect(
      createPasswordResetLink(client(), { email: "nobody@example.com" }),
    ).resolves.toBeNull();
  });

  it("limits an account to one recovery email per minute", async () => {
    await initialized();
    const now = new Date("2026-11-18T12:00:00.000Z");
    await expect(
      createPasswordResetLink(client(), { email: "owner@example.com", now }),
    ).resolves.not.toBeNull();
    await expect(
      createPasswordResetLink(client(), {
        email: "owner@example.com",
        now: new Date(now.getTime() + 30_000),
      }),
    ).resolves.toBeNull();
  });

  it("replaces the password, ends existing sessions, and works once", async () => {
    const setup = await initialized();
    const before = await db.query<{ stamp: string }>("SELECT stamp FROM users WHERE id = $1", [
      setup.owner.id,
    ]);
    const link = await createPasswordResetLink(client(), { email: " OWNER@example.com " });
    expect(link).toMatchObject({
      email: "owner@example.com",
      workspaceId: setup.workspace.id,
      workspaceName: "Acme",
    });
    if (!link) throw new Error("Expected a password reset link.");

    const reset = await consumePasswordResetLink(client(), {
      token: link.token,
      passwordHash: "scrypt$new$key",
    });
    expect(reset.user.id).toBe(setup.owner.id);
    const after = await db.query<{ password_hash: string; stamp: string }>(
      "SELECT password_hash, stamp FROM users WHERE id = $1",
      [setup.owner.id],
    );
    expect(after.rows[0]?.password_hash).toBe("scrypt$new$key");
    expect(after.rows[0]?.stamp).not.toBe(before.rows[0]?.stamp);
    await expect(
      consumePasswordResetLink(client(), {
        token: link.token,
        passwordHash: "scrypt$another$key",
      }),
    ).rejects.toMatchObject({ code: "account_link_invalid", status: 410 });
  });
});
