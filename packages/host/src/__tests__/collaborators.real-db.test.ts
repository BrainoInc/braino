import type { PoolClient } from "@braino/db";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { acceptWorkspaceInvitation, createWorkspaceInvitation } from "../account-links.js";
import {
  listWorkspaceCollaborators,
  removeWorkspaceCollaborator,
  updateWorkspaceCollaborator,
} from "../collaborators.js";
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
    ownerPasswordHash: "scrypt$salt$key",
  });
}

async function addCollaborator(
  setup: Awaited<ReturnType<typeof initialized>>,
  input: { email: string; username: string; name: string; role: "writer" | "reader" },
) {
  const invitation = await createWorkspaceInvitation(client(), {
    workspaceId: setup.workspace.id,
    actorId: setup.owner.id,
    email: input.email,
    role: input.role,
    writeTypes: [],
  });
  const accepted = await acceptWorkspaceInvitation(client(), {
    token: invitation.token,
    username: input.username,
    name: input.name,
    passwordHash: `scrypt$${input.username}$key`,
  });
  const added = (await listWorkspaceCollaborators(client(), setup.workspace.id)).find(
    (person) => person.id === accepted.user.id,
  );
  if (!added) throw new Error("Accepted collaborator was not listed.");
  return added;
}

describe("single-workspace collaborators", () => {
  it("lists an accepted invitation with its explicit workspace grant", async () => {
    const setup = await initialized();

    const added = await addCollaborator(setup, {
      email: "writer@example.com",
      username: "writer",
      name: "Workspace Writer",
      role: "writer",
    });

    expect(added).toMatchObject({
      email: "writer@example.com",
      username: "writer",
      name: "Workspace Writer",
      role: "writer",
      write_types: ["*"],
    });
    const members = await listWorkspaceCollaborators(client(), setup.workspace.id);
    expect(members).toEqual([
      expect.objectContaining({ id: setup.owner.id, role: "owner" }),
      expect.objectContaining({ id: added.id, role: "writer", write_types: ["*"] }),
    ]);
  });

  it("updates per-type access without accepting unknown grant tokens", async () => {
    const setup = await initialized();
    const added = await addCollaborator(setup, {
      email: "reader@example.com",
      username: "reader",
      name: "Workspace Reader",
      role: "reader",
    });

    const updated = await updateWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      userId: added.id,
      role: "reader",
      writeTypes: ["decision", "relates_to", "not-a-type"],
    });

    expect(updated).toMatchObject({
      id: added.id,
      role: "reader",
      write_types: ["decision", "relates_to"],
    });
  });

  it("keeps membership administration with owners and prevents self-lockout", async () => {
    const setup = await initialized();

    await expect(
      createWorkspaceInvitation(client(), {
        workspaceId: setup.workspace.id,
        actorId: "user_01J00000000000000000000000",
        email: "blocked@example.com",
        role: "reader",
        writeTypes: [],
      }),
    ).rejects.toMatchObject({ code: "owner_required", status: 403 });

    await expect(
      updateWorkspaceCollaborator(client(), {
        workspaceId: setup.workspace.id,
        actorId: setup.owner.id,
        userId: setup.owner.id,
        role: "reader",
        writeTypes: [],
      }),
    ).rejects.toMatchObject({ code: "cannot_change_own_access", status: 409 });

    await expect(
      removeWorkspaceCollaborator(client(), {
        workspaceId: setup.workspace.id,
        actorId: setup.owner.id,
        userId: setup.owner.id,
      }),
    ).rejects.toMatchObject({ code: "cannot_change_own_access", status: 409 });
  });

  it("removes workspace access without deleting the person's account", async () => {
    const setup = await initialized();
    const added = await addCollaborator(setup, {
      email: "former@example.com",
      username: "former",
      name: "Former Collaborator",
      role: "reader",
    });

    const before = await db.query<{ stamp: string }>("SELECT stamp FROM users WHERE id = $1", [
      added.id,
    ]);
    await removeWorkspaceCollaborator(client(), {
      workspaceId: setup.workspace.id,
      actorId: setup.owner.id,
      userId: added.id,
    });

    const rows = await db.query<{ users: number; memberships: number; stamp: string }>(
      `SELECT
         (SELECT count(*)::int FROM users WHERE id = $1) AS users,
         (SELECT count(*)::int FROM workspace_users WHERE user_id = $1) AS memberships,
         (SELECT stamp FROM users WHERE id = $1) AS stamp`,
      [added.id],
    );
    expect(rows.rows[0]).toMatchObject({ users: 1, memberships: 0 });
    expect(rows.rows[0]?.stamp).not.toBe(before.rows[0]?.stamp);
  });
});
