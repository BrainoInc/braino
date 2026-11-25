import type { CollectionRole, PoolClient } from "@braino/db";
import { WRITE_ALL, normalizeWriteTypes } from "@braino/shared";

const ROLES = new Set<CollectionRole>(["owner", "writer", "reader"]);

export interface WorkspaceCollaborator {
  id: string;
  email: string;
  username: string;
  name: string;
  role: CollectionRole;
  write_types: string[];
  joined_at: string;
}

export class WorkspaceAccessError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "WorkspaceAccessError";
  }
}

export function normalizeWorkspaceRole(value: unknown): CollectionRole {
  if (typeof value === "string" && ROLES.has(value as CollectionRole)) {
    return value as CollectionRole;
  }
  throw new WorkspaceAccessError("Role must be owner, writer, or reader.", "invalid_role");
}

export function workspaceWriteTypes(memberRole: CollectionRole, raw: unknown): string[] {
  if (memberRole === "owner") return [];
  if (memberRole === "writer") return [WRITE_ALL];
  return normalizeWriteTypes(raw);
}

function mapCollaborator(row: Record<string, unknown>): WorkspaceCollaborator {
  const memberRole = normalizeWorkspaceRole(row.role);
  const joinedAt = row.joined_at;
  return {
    id: String(row.id),
    email: String(row.email),
    username: String(row.username),
    name: String(row.name),
    role: memberRole,
    write_types: workspaceWriteTypes(memberRole, row.write_types),
    joined_at: joinedAt instanceof Date ? joinedAt.toISOString() : String(joinedAt),
  };
}

export async function requireWorkspaceOwner(
  client: PoolClient,
  workspaceId: string,
  actorId: string,
) {
  const found = await client.query<{ role: string }>(
    "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, actorId],
  );
  if (found.rows[0]?.role !== "owner") {
    throw new WorkspaceAccessError(
      "Only workspace owners can manage collaborators.",
      "owner_required",
      403,
    );
  }
}

async function collaborator(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceCollaborator> {
  const found = await client.query(
    `SELECT u.id, u.email, u.username, u.name, wu.role, wu.write_types, wu.joined_at
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
      WHERE wu.workspace_id = $1 AND wu.user_id = $2`,
    [workspaceId, userId],
  );
  if (!found.rows[0]) {
    throw new WorkspaceAccessError("Collaborator not found.", "collaborator_not_found", 404);
  }
  return mapCollaborator(found.rows[0]);
}

export async function listWorkspaceCollaborators(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceCollaborator[]> {
  const found = await client.query(
    `SELECT u.id, u.email, u.username, u.name, wu.role, wu.write_types, wu.joined_at
       FROM workspace_users wu
       JOIN users u ON u.id = wu.user_id
      WHERE wu.workspace_id = $1 AND u.deactivated_at IS NULL
      ORDER BY CASE wu.role WHEN 'owner' THEN 0 WHEN 'writer' THEN 1 ELSE 2 END,
               wu.joined_at, lower(u.username)`,
    [workspaceId],
  );
  return found.rows.map(mapCollaborator);
}

export async function updateWorkspaceCollaborator(
  client: PoolClient,
  input: {
    workspaceId: string;
    actorId: string;
    userId: string;
    role: CollectionRole;
    writeTypes: string[];
  },
): Promise<WorkspaceCollaborator> {
  if (input.actorId === input.userId) {
    throw new WorkspaceAccessError(
      "Use another owner to change your own access.",
      "cannot_change_own_access",
      409,
    );
  }
  const memberRole = normalizeWorkspaceRole(input.role);
  const writeTypes = workspaceWriteTypes(memberRole, input.writeTypes);
  await client.query("BEGIN");
  try {
    await requireWorkspaceOwner(client, input.workspaceId, input.actorId);
    const updated = await client.query(
      `UPDATE workspace_users SET role = $3, write_types = $4
        WHERE workspace_id = $1 AND user_id = $2
        RETURNING user_id`,
      [input.workspaceId, input.userId, memberRole, writeTypes],
    );
    if (!updated.rows[0]) {
      throw new WorkspaceAccessError("Collaborator not found.", "collaborator_not_found", 404);
    }
    const result = await collaborator(client, input.workspaceId, input.userId);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function removeWorkspaceCollaborator(
  client: PoolClient,
  input: { workspaceId: string; actorId: string; userId: string },
): Promise<void> {
  if (input.actorId === input.userId) {
    throw new WorkspaceAccessError(
      "Use another owner to remove your own access.",
      "cannot_change_own_access",
      409,
    );
  }
  await client.query("BEGIN");
  try {
    await requireWorkspaceOwner(client, input.workspaceId, input.actorId);
    const removed = await client.query(
      "DELETE FROM workspace_users WHERE workspace_id = $1 AND user_id = $2 RETURNING user_id",
      [input.workspaceId, input.userId],
    );
    if (!removed.rows[0]) {
      throw new WorkspaceAccessError("Collaborator not found.", "collaborator_not_found", 404);
    }
    await client.query(
      "UPDATE users SET stamp = gen_random_uuid()::text, updated_at = now() WHERE id = $1",
      [input.userId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
