import type { GithubAppConnectorPlugin, GithubAppRegistration } from "@doco/connector-plugins";
import { createGithubAppPlugin } from "@doco/connector-plugins";
import type { PoolClient } from "@doco/db";
import { openSecret, sealSecret } from "./secret-box.js";

const SETUP_TTL_MS = 10 * 60 * 1000;

export interface GithubAppRegistrationSummary {
  appId: number;
  slug: string;
  htmlUrl: string;
  clientId: string;
}

interface RegistrationRow {
  app_id: string | number;
  slug: string;
  html_url: string;
  client_id: string;
  private_key_sealed: string;
  webhook_secret_sealed: string;
}

export interface GithubSetupState {
  workspaceId: string;
  userId: string;
  purpose: "create" | "install";
}

interface StoredGithubSetupState extends GithubSetupState {
  expiresAt: string;
}

function setupState(value: unknown): StoredGithubSetupState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub setup state is invalid.");
  }
  const state = value as Partial<StoredGithubSetupState>;
  if (
    typeof state.workspaceId !== "string" ||
    !state.workspaceId ||
    typeof state.userId !== "string" ||
    !state.userId ||
    (state.purpose !== "create" && state.purpose !== "install") ||
    typeof state.expiresAt !== "string"
  ) {
    throw new Error("GitHub setup state is invalid.");
  }
  return state as StoredGithubSetupState;
}

export function createGithubSetupState(
  input: GithubSetupState,
  encryptionKey: string,
  now = new Date(),
): string {
  return sealSecret(
    JSON.stringify({ ...input, expiresAt: new Date(now.getTime() + SETUP_TTL_MS).toISOString() }),
    encryptionKey,
  );
}

export function readGithubSetupState(
  value: string,
  encryptionKey: string,
  now = new Date(),
): GithubSetupState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(value, encryptionKey));
  } catch {
    throw new Error("GitHub setup state is invalid.");
  }
  const state = setupState(parsed);
  if (new Date(state.expiresAt).getTime() <= now.getTime()) {
    throw new Error("GitHub setup state expired. Start again from Integrations.");
  }
  return { workspaceId: state.workspaceId, userId: state.userId, purpose: state.purpose };
}

async function requireOwner(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const found = await client.query(
    `SELECT 1 FROM workspace_users
      WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`,
    [workspaceId, userId],
  );
  if (!found.rows[0]) throw new Error("Only workspace owners can configure GitHub.");
}

export async function saveGithubAppRegistration(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    registration: GithubAppRegistration;
    encryptionKey: string;
  },
): Promise<GithubAppRegistrationSummary> {
  await requireOwner(client, input.workspaceId, input.userId);
  const privateKeySealed = sealSecret(input.registration.privateKey, input.encryptionKey);
  const webhookSecretSealed = sealSecret(input.registration.webhookSecret, input.encryptionKey);
  const saved = await client.query<RegistrationRow>(
    `INSERT INTO github_app_registrations
       (workspace_id, app_id, slug, html_url, client_id, private_key_sealed,
        webhook_secret_sealed, created_by_user_id, updated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (workspace_id) DO UPDATE
       SET app_id = EXCLUDED.app_id,
           slug = EXCLUDED.slug,
           html_url = EXCLUDED.html_url,
           client_id = EXCLUDED.client_id,
           private_key_sealed = EXCLUDED.private_key_sealed,
           webhook_secret_sealed = EXCLUDED.webhook_secret_sealed,
           updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_at = now()
     RETURNING app_id, slug, html_url, client_id, private_key_sealed,
               webhook_secret_sealed`,
    [
      input.workspaceId,
      input.registration.appId,
      input.registration.slug,
      input.registration.htmlUrl,
      input.registration.clientId,
      privateKeySealed,
      webhookSecretSealed,
      input.userId,
    ],
  );
  const row = saved.rows[0];
  if (!row) throw new Error("GitHub App registration was not saved.");
  return {
    appId: Number(row.app_id),
    slug: row.slug,
    htmlUrl: row.html_url,
    clientId: row.client_id,
  };
}

export async function getGithubAppRegistration(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    fetcher?: typeof fetch;
    jwt?: () => string;
  },
): Promise<{ summary: GithubAppRegistrationSummary; plugin: GithubAppConnectorPlugin } | null> {
  const found = await client.query<RegistrationRow>(
    `SELECT app_id, slug, html_url, client_id, private_key_sealed,
            webhook_secret_sealed
       FROM github_app_registrations
      WHERE workspace_id = $1`,
    [input.workspaceId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const summary = {
    appId: Number(row.app_id),
    slug: row.slug,
    htmlUrl: row.html_url,
    clientId: row.client_id,
  };
  return {
    summary,
    plugin: createGithubAppPlugin({
      credentials: {
        ...summary,
        privateKey: openSecret(row.private_key_sealed, input.encryptionKey),
        webhookSecret: openSecret(row.webhook_secret_sealed, input.encryptionKey),
      },
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      ...(input.jwt ? { jwt: input.jwt } : {}),
    }),
  };
}

export async function getGithubAppRegistrationSummary(
  client: PoolClient,
  workspaceId: string,
): Promise<GithubAppRegistrationSummary | null> {
  const found = await client.query<
    Pick<RegistrationRow, "app_id" | "slug" | "html_url" | "client_id">
  >(
    `SELECT app_id, slug, html_url, client_id
       FROM github_app_registrations
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = found.rows[0];
  return row
    ? { appId: Number(row.app_id), slug: row.slug, htmlUrl: row.html_url, clientId: row.client_id }
    : null;
}

export async function getOnlyGithubAppRegistration(
  client: PoolClient,
  input: { encryptionKey: string; fetcher?: typeof fetch },
): Promise<{
  workspaceId: string;
  summary: GithubAppRegistrationSummary;
  plugin: GithubAppConnectorPlugin;
} | null> {
  const found = await client.query<{ workspace_id: string }>(
    "SELECT workspace_id FROM github_app_registrations ORDER BY created_at LIMIT 2",
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1)
    throw new Error("This host has more than one GitHub App registration.");
  const workspaceId = found.rows[0]?.workspace_id;
  if (!workspaceId) return null;
  const registration = await getGithubAppRegistration(client, { workspaceId, ...input });
  return registration ? { workspaceId, ...registration } : null;
}
