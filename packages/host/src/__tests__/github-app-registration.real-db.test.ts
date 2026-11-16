import type { PGlite } from "@electric-sql/pglite";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import {
  createGithubSetupState,
  getGithubAppRegistration,
  readGithubSetupState,
  saveGithubAppRegistration,
} from "../github-app-registration.js";
import { initializeSingleWorkspace } from "../single-workspace.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;
const encryptionKey = "github-app-registration-test-key-over-thirty-two-characters";

async function fixture() {
  return initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
}

describe("deployment-owned GitHub App registration", () => {
  it("seals App secrets and restores the provider plugin without exposing them", async () => {
    const setup = await fixture();
    await saveGithubAppRegistration(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      registration: {
        appId: 99,
        slug: "acme-braino",
        htmlUrl: "https://github.com/apps/acme-braino",
        clientId: "Iv1.client",
        clientSecret: "discarded-client-secret",
        privateKey: "private-key",
        webhookSecret: "webhook-secret",
      },
      encryptionKey,
    });

    const stored = await db.query<{
      private_key_sealed: string;
      webhook_secret_sealed: string;
    }>("SELECT private_key_sealed, webhook_secret_sealed FROM github_app_registrations");
    expect(stored.rows[0]?.private_key_sealed).not.toContain("private-key");
    expect(stored.rows[0]?.webhook_secret_sealed).not.toContain("webhook-secret");
    expect(JSON.stringify(stored.rows[0])).not.toContain("discarded-client-secret");

    const loaded = await getGithubAppRegistration(client(), {
      workspaceId: setup.workspace.id,
      encryptionKey,
      fetcher: (async () => new Response("unused", { status: 500 })) as typeof fetch,
      jwt: () => "app-jwt",
    });
    expect(loaded?.summary).toEqual({
      appId: 99,
      slug: "acme-braino",
      htmlUrl: "https://github.com/apps/acme-braino",
      clientId: "Iv1.client",
    });
    await expect(loaded?.plugin.github.mintInstallationToken(7)).rejects.toMatchObject({
      code: "github_request_failed",
    });
  });

  it("seals a short-lived setup state to the owner and workspace", async () => {
    const setup = await fixture();
    const state = createGithubSetupState(
      {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        purpose: "create",
      },
      encryptionKey,
      new Date("2026-11-16T16:00:00Z"),
    );

    expect(readGithubSetupState(state, encryptionKey, new Date("2026-11-16T16:09:59Z"))).toEqual({
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      purpose: "create",
    });
    expect(() =>
      readGithubSetupState(state, encryptionKey, new Date("2026-11-16T16:10:01Z")),
    ).toThrow("expired");
  });
});
