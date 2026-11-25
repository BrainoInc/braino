import { createHash, randomBytes } from "node:crypto";
import type { CollectionRole, PoolClient } from "@braino/db";
import { generateUlid, makeEntityId } from "@braino/shared";
import {
  normalizeWorkspaceRole,
  requireWorkspaceOwner,
  workspaceWriteTypes,
} from "./collaborators.js";

const INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1000;
const PASSWORD_RESET_LIFETIME_MS = 60 * 60 * 1000;
const USERNAME = /^[a-z0-9][a-z0-9_-]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AccountLinkError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "AccountLinkError";
  }
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: CollectionRole;
  writeTypes: string[];
  createdAt: string;
  expiresAt: string;
}

export interface CreatedWorkspaceInvitation extends WorkspaceInvitation {
  token: string;
}

function normalizedEmail(value: string): string {
  return value.trim().toLowerCase();
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function token(): string {
  return randomBytes(32).toString("base64url");
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function active(
  row: {
    expires_at: Date | string;
    consumed_at: Date | string | null;
    revoked_at: Date | string | null;
  },
  now: Date,
) {
  return !row.consumed_at && !row.revoked_at && new Date(row.expires_at).getTime() > now.getTime();
}

function invalidLink(): AccountLinkError {
  return new AccountLinkError(
    "This account link is invalid or has expired.",
    "account_link_invalid",
    410,
  );
}

export async function createWorkspaceInvitation(
  client: PoolClient,
  input: {
    workspaceId: string;
    actorId: string;
    email: string;
    role: CollectionRole;
    writeTypes: string[];
    now?: Date;
  },
): Promise<CreatedWorkspaceInvitation> {
  const email = normalizedEmail(input.email);
  if (!EMAIL.test(email)) {
    throw new AccountLinkError("A valid email is required.", "invalid_email");
  }
  const role = normalizeWorkspaceRole(input.role);
  const writeTypes = workspaceWriteTypes(role, input.writeTypes);
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_LIFETIME_MS);
  const plainToken = token();
  const id = `account_link_${generateUlid()}`;

  await client.query("BEGIN");
  try {
    await requireWorkspaceOwner(client, input.workspaceId, input.actorId);
    const member = await client.query(
      `SELECT 1
         FROM workspace_users wu
         JOIN users u ON u.id = wu.user_id
        WHERE wu.workspace_id = $1 AND lower(u.email) = $2 AND u.deactivated_at IS NULL`,
      [input.workspaceId, email],
    );
    if (member.rows[0]) {
      throw new AccountLinkError(
        "That person is already a collaborator.",
        "already_collaborator",
        409,
      );
    }
    await client.query(
      `UPDATE account_links
          SET revoked_at = $3
        WHERE workspace_id = $1 AND kind = 'workspace_invitation' AND lower(email) = $2
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [input.workspaceId, email, now.toISOString()],
    );
    await client.query(
      `INSERT INTO account_links
         (id, token_hash, kind, workspace_id, email, role, write_types,
          created_by_user_id, created_at, expires_at)
       VALUES ($1, $2, 'workspace_invitation', $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        digest(plainToken),
        input.workspaceId,
        email,
        role,
        writeTypes,
        input.actorId,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return {
    id,
    token: plainToken,
    email,
    role,
    writeTypes,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listWorkspaceInvitations(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceInvitation[]> {
  const found = await client.query<{
    id: string;
    email: string;
    role: CollectionRole;
    write_types: string[];
    created_at: Date | string;
    expires_at: Date | string;
  }>(
    `SELECT id, email, role, write_types, created_at, expires_at
       FROM account_links
      WHERE workspace_id = $1 AND kind = 'workspace_invitation'
        AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at, id`,
    [workspaceId],
  );
  return found.rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: normalizeWorkspaceRole(row.role),
    writeTypes: workspaceWriteTypes(row.role, row.write_types),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
  }));
}

export async function getWorkspaceInvitation(
  client: PoolClient,
  input: { token: string; now?: Date },
): Promise<{
  email: string;
  role: CollectionRole;
  workspace: { id: string; handle: string; name: string };
  expiresAt: string;
}> {
  const now = input.now ?? new Date();
  const found = await client.query<{
    email: string;
    role: CollectionRole;
    expires_at: Date | string;
    consumed_at: Date | string | null;
    revoked_at: Date | string | null;
    workspace_id: string;
    workspace_handle: string;
    workspace_name: string;
  }>(
    `SELECT l.email, l.role, l.expires_at, l.consumed_at, l.revoked_at,
            w.id AS workspace_id, w.handle AS workspace_handle, w.name AS workspace_name
       FROM account_links l
       JOIN workspaces w ON w.id = l.workspace_id
      WHERE l.token_hash = $1 AND l.kind = 'workspace_invitation'`,
    [digest(input.token)],
  );
  const link = found.rows[0];
  if (!link || !active(link, now)) throw invalidLink();
  return {
    email: link.email,
    role: normalizeWorkspaceRole(link.role),
    workspace: {
      id: link.workspace_id,
      handle: link.workspace_handle,
      name: link.workspace_name,
    },
    expiresAt: iso(link.expires_at),
  };
}

export async function revokeWorkspaceInvitation(
  client: PoolClient,
  input: { workspaceId: string; actorId: string; invitationId: string; now?: Date },
): Promise<void> {
  await client.query("BEGIN");
  try {
    await requireWorkspaceOwner(client, input.workspaceId, input.actorId);
    const revoked = await client.query(
      `UPDATE account_links
          SET revoked_at = $3
        WHERE id = $1 AND workspace_id = $2 AND kind = 'workspace_invitation'
          AND consumed_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [input.invitationId, input.workspaceId, (input.now ?? new Date()).toISOString()],
    );
    if (!revoked.rows[0]) {
      throw new AccountLinkError("Invitation not found.", "invitation_not_found", 404);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function acceptWorkspaceInvitation(
  client: PoolClient,
  input: {
    token: string;
    username: string;
    name: string;
    passwordHash: string;
    now?: Date;
  },
): Promise<{
  workspace: { id: string; handle: string; name: string };
  user: { id: string; email: string; username: string; name: string; stamp: string };
}> {
  const now = input.now ?? new Date();
  const username = input.username.trim().toLowerCase();
  const name = input.name.trim();
  if (!USERNAME.test(username)) {
    throw new AccountLinkError(
      "Username must start with a letter or number and contain only lowercase letters, numbers, hyphens, or underscores.",
      "invalid_username",
    );
  }
  if (!name) throw new AccountLinkError("Name is required.", "name_required");
  if (!input.passwordHash.trim()) {
    throw new AccountLinkError("Password hash is required.", "password_required");
  }

  await client.query("BEGIN");
  try {
    const found = await client.query<{
      id: string;
      workspace_id: string;
      email: string;
      role: CollectionRole;
      write_types: string[];
      expires_at: Date | string;
      consumed_at: Date | string | null;
      revoked_at: Date | string | null;
      workspace_handle: string;
      workspace_name: string;
    }>(
      `SELECT l.id, l.workspace_id, l.email, l.role, l.write_types, l.expires_at,
              l.consumed_at, l.revoked_at, w.handle AS workspace_handle,
              w.name AS workspace_name
         FROM account_links l
         JOIN workspaces w ON w.id = l.workspace_id
        WHERE l.token_hash = $1 AND l.kind = 'workspace_invitation'
        FOR UPDATE OF l`,
      [digest(input.token)],
    );
    const link = found.rows[0];
    if (!link || !active(link, now)) throw invalidLink();

    const byEmail = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = lower($1) FOR UPDATE",
      [link.email],
    );
    const byUsername = await client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(username) = $1 FOR UPDATE",
      [username],
    );
    const existingId = byEmail.rows[0]?.id;
    if (byUsername.rows[0] && byUsername.rows[0].id !== existingId) {
      throw new AccountLinkError("That username is already in use.", "username_taken", 409);
    }
    const userId = existingId ?? makeEntityId("user", generateUlid());
    const user = existingId
      ? await client.query<{ stamp: string }>(
          `UPDATE users
              SET username = $2, name = $3, password_hash = $4,
                  stamp = gen_random_uuid()::text, deactivated_at = NULL, updated_at = $5
            WHERE id = $1
            RETURNING stamp`,
          [userId, username, name, input.passwordHash, now.toISOString()],
        )
      : await client.query<{ stamp: string }>(
          `INSERT INTO users (id, username, name, email, password_hash, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, $6, $6)
           RETURNING stamp`,
          [userId, username, name, link.email, input.passwordHash, now.toISOString()],
        );
    await client.query(
      `INSERT INTO workspace_users (workspace_id, user_id, role, write_types, joined_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [link.workspace_id, userId, link.role, link.write_types, now.toISOString()],
    );
    await client.query("UPDATE account_links SET consumed_at = $2 WHERE id = $1", [
      link.id,
      now.toISOString(),
    ]);
    const stamp = user.rows[0]?.stamp;
    if (!stamp) throw new Error("The collaborator session stamp was not created.");
    await client.query("COMMIT");
    return {
      workspace: {
        id: link.workspace_id,
        handle: link.workspace_handle,
        name: link.workspace_name,
      },
      user: {
        id: userId,
        email: link.email,
        username,
        name,
        stamp,
      },
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function createPasswordResetLink(
  client: PoolClient,
  input: { email: string; now?: Date },
): Promise<null | {
  token: string;
  email: string;
  workspaceId: string;
  workspaceName: string;
  expiresAt: string;
}> {
  const email = normalizedEmail(input.email);
  if (!EMAIL.test(email)) return null;
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.getTime() + PASSWORD_RESET_LIFETIME_MS);
  const plainToken = token();
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`password_reset:${email}`]);
    const account = await client.query<{
      id: string;
      email: string;
      workspace_id: string;
      workspace_name: string;
    }>(
      `SELECT u.id, u.email, w.id AS workspace_id, w.name AS workspace_name
         FROM users u
         JOIN workspace_users wu ON wu.user_id = u.id
         JOIN workspaces w ON w.id = wu.workspace_id
        WHERE lower(u.email) = $1 AND u.deactivated_at IS NULL
        LIMIT 1`,
      [email],
    );
    const user = account.rows[0];
    if (!user) {
      await client.query("COMMIT");
      return null;
    }
    const recentlyRequested = await client.query(
      `SELECT 1 FROM account_links
        WHERE kind = 'password_reset' AND user_id = $1
          AND created_at > $2::timestamptz - interval '1 minute'
        LIMIT 1`,
      [user.id, now.toISOString()],
    );
    if (recentlyRequested.rows[0]) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE account_links
          SET revoked_at = $2
        WHERE kind = 'password_reset' AND user_id = $1
          AND consumed_at IS NULL AND revoked_at IS NULL`,
      [user.id, now.toISOString()],
    );
    await client.query(
      `INSERT INTO account_links
         (id, token_hash, kind, workspace_id, email, user_id, created_at, expires_at)
       VALUES ($1, $2, 'password_reset', $3, $4, $5, $6, $7)`,
      [
        `account_link_${generateUlid()}`,
        digest(plainToken),
        user.workspace_id,
        user.email,
        user.id,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    await client.query("COMMIT");
    return {
      token: plainToken,
      email: user.email,
      workspaceId: user.workspace_id,
      workspaceName: user.workspace_name,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function getPasswordResetLink(
  client: PoolClient,
  input: { token: string; now?: Date },
): Promise<{ email: string; workspaceId: string; workspaceName: string; expiresAt: string }> {
  const now = input.now ?? new Date();
  const found = await client.query<{
    email: string;
    workspace_id: string;
    workspace_name: string;
    expires_at: Date | string;
    consumed_at: Date | string | null;
    revoked_at: Date | string | null;
  }>(
    `SELECT l.email, l.workspace_id, w.name AS workspace_name, l.expires_at,
            l.consumed_at, l.revoked_at
       FROM account_links l
       JOIN workspaces w ON w.id = l.workspace_id
      WHERE l.token_hash = $1 AND l.kind = 'password_reset'`,
    [digest(input.token)],
  );
  const link = found.rows[0];
  if (!link || !active(link, now)) throw invalidLink();
  return {
    email: link.email,
    workspaceId: link.workspace_id,
    workspaceName: link.workspace_name,
    expiresAt: iso(link.expires_at),
  };
}

export async function consumePasswordResetLink(
  client: PoolClient,
  input: { token: string; passwordHash: string; now?: Date },
): Promise<{ user: { id: string; email: string; stamp: string }; workspaceId: string }> {
  const now = input.now ?? new Date();
  await client.query("BEGIN");
  try {
    const found = await client.query<{
      id: string;
      workspace_id: string;
      user_id: string;
      email: string;
      expires_at: Date | string;
      consumed_at: Date | string | null;
      revoked_at: Date | string | null;
    }>(
      `SELECT id, workspace_id, user_id, email, expires_at, consumed_at, revoked_at
         FROM account_links
        WHERE token_hash = $1 AND kind = 'password_reset'
        FOR UPDATE`,
      [digest(input.token)],
    );
    const link = found.rows[0];
    if (!link || !active(link, now)) throw invalidLink();
    const updated = await client.query<{ stamp: string }>(
      `UPDATE users
          SET password_hash = $2, stamp = gen_random_uuid()::text, updated_at = $3
        WHERE id = $1 AND deactivated_at IS NULL
        RETURNING stamp`,
      [link.user_id, input.passwordHash, now.toISOString()],
    );
    const stamp = updated.rows[0]?.stamp;
    if (!stamp) throw invalidLink();
    await client.query("UPDATE account_links SET consumed_at = $2 WHERE id = $1", [
      link.id,
      now.toISOString(),
    ]);
    await client.query("COMMIT");
    return {
      user: { id: link.user_id, email: link.email, stamp },
      workspaceId: link.workspace_id,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
