import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type PoolClient,
  appendAuditEventRow,
  appendNodeVersion,
  createChangeset,
  nodeRowFromFields,
  upsertNode,
} from "@doco/db";
import {
  type CodeGraphClient,
  configuredCodeGraphClient,
  syncCodeGraphCollection,
  syncCodeGraphRepository,
} from "@doco/index";
import { generateUlid, makeEntityId } from "@doco/shared";
import type { ClientScope } from "./client-scope.js";
import { createCollectionInWorkspace } from "./host.js";
import { createWorkspaceBrief } from "./mcp-core.js";
import type { PluginGithubProvider } from "./plugin-github.js";
import { openSecret, sealSecret } from "./secret-box.js";

const API = "https://api.github.com";
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const MAX_GITHUB_PAGE_BYTES = 10 * 1024 * 1024;
const MAX_GITHUB_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MAX_GITHUB_ITEMS = 10_000;
const MAX_CODE_FILE_BYTES = 200_000;
const GITHUB_BLOB_CONCURRENCY = 20;

export class GithubConnectionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "GithubConnectionError";
  }
}

export interface GithubConnectionSummary {
  id: string;
  repository: string;
  issuesCollectionHandle: string;
  pullRequestsCollectionHandle: string;
  codeCollectionHandle: string;
  active: boolean;
  gatewayConnected: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  webhookConfigured: boolean;
  webhookUrl: string | null;
  webhookLastDeliveryAt: string | null;
}

type Fetcher = typeof fetch;

interface ConnectionRow {
  id: string;
  workspace_id: string;
  repository: string;
  token_sealed: string | null;
  plugin_installation_id: string | null;
  issues_collection_id: string;
  pull_requests_collection_id: string;
  code_collection_id: string;
  created_by_user_id: string;
  active: boolean;
  webhook_id: string | number | null;
  webhook_secret_sealed: string | null;
  webhook_url: string | null;
  sync_token: string | null;
  sync_started_at: Date | string | null;
}

interface ClaimedConnection {
  connection: ConnectionRow;
  syncToken: string;
}

interface GithubItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user?: { login?: string } | null;
  labels?: Array<{ name?: string } | string>;
  comments?: number;
  locked?: boolean;
  pull_request?: unknown;
  draft?: boolean;
  merged_at?: string | null;
  head?: { ref?: string };
  base?: { ref?: string };
}

interface StoredNode {
  id: string;
  node_type: string;
  lifecycle: string;
  prose: string;
  kind: string | null;
  locator: string | null;
  extra: Record<string, unknown>;
  created_at: Date | string;
  created_by: string | null;
  updated_at: Date | string;
  updated_by: string | null;
}

function normalizeRepository(value: string): string {
  const repository = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "");
  if (!REPOSITORY.test(repository)) {
    throw new GithubConnectionError(
      "Use a GitHub repository in owner/name form.",
      "repository_invalid",
    );
  }
  return repository.toLowerCase();
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
  if (!found.rows[0]) {
    throw new GithubConnectionError(
      "Only workspace owners can manage GitHub connections.",
      "owner_required",
      403,
    );
  }
}

async function claimGithubOperation(
  withClient: ClientScope,
  input: { connectionId: string; userId?: string },
): Promise<ClaimedConnection> {
  const syncToken = generateUlid();
  const connection = await withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const found = await client.query<ConnectionRow>(
        "SELECT * FROM github_connections WHERE id = $1 FOR UPDATE",
        [input.connectionId],
      );
      const row = found.rows[0];
      if (!row || !row.active || (!row.token_sealed && !row.plugin_installation_id)) {
        throw new GithubConnectionError(
          "GitHub connection is not active.",
          "connection_inactive",
          409,
        );
      }
      if (input.userId) await requireOwner(client, row.workspace_id, input.userId);
      const claimed = await client.query<ConnectionRow>(
        `UPDATE github_connections
            SET sync_token = $2, sync_started_at = now()
          WHERE id = $1
            AND (
              sync_token IS NULL OR sync_started_at IS NULL
              OR sync_started_at < now() - interval '30 minutes'
            )
        RETURNING *`,
        [row.id, syncToken],
      );
      const active = claimed.rows[0];
      if (!active || (!active.token_sealed && !active.plugin_installation_id)) {
        throw new GithubConnectionError(
          "This GitHub connection already has an operation in progress.",
          "sync_in_progress",
          409,
        );
      }
      await client.query("COMMIT");
      return active;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  return { connection, syncToken };
}

async function failGithubOperation(
  withClient: ClientScope,
  claimed: ClaimedConnection,
  error: unknown,
): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE github_connections
          SET last_error = $2, sync_token = NULL, sync_started_at = NULL
        WHERE id = $1 AND sync_token = $3`,
      [
        claimed.connection.id,
        error instanceof Error ? error.message.slice(0, 500) : "GitHub operation failed.",
        claimed.syncToken,
      ],
    );
  });
}

function headers(accessToken: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "doco-self-hosted",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubFetch(fetcher: Fetcher, url: string, init: RequestInit): Promise<Response> {
  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  try {
    return await fetcher(url, { ...init, signal: timeout });
  } catch (error) {
    if (timeout.aborted) {
      throw new GithubConnectionError(
        "GitHub did not respond within 30 seconds.",
        "github_timeout",
        504,
      );
    }
    throw error;
  }
}

async function githubJson(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
): Promise<{ value: unknown; response: Response; bytes: number }> {
  const response = await githubFetch(fetcher, url, { headers: headers(accessToken) });
  if (!response.ok) {
    const message =
      response.status === 401 || response.status === 403
        ? "GitHub rejected the token. Grant Metadata, Contents, Issues, and Pull requests read access."
        : `GitHub returned ${response.status} while reading the repository.`;
    throw new GithubConnectionError(message, "github_request_failed", 502);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_GITHUB_PAGE_BYTES) {
    await response.body?.cancel();
    throw new GithubConnectionError(
      "GitHub returned a page larger than 10 MB.",
      "github_too_large",
      422,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new GithubConnectionError(
      "GitHub returned an unreadable response.",
      "github_response_invalid",
      502,
    );
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_GITHUB_PAGE_BYTES) {
      await reader.cancel();
      throw new GithubConnectionError(
        "GitHub returned a page larger than 10 MB.",
        "github_too_large",
        422,
      );
    }
    chunks.push(part.value);
  }
  try {
    const value = JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        bytes,
      ).toString(),
    );
    return { value, response, bytes };
  } catch {
    throw new GithubConnectionError(
      "GitHub returned invalid JSON.",
      "github_response_invalid",
      502,
    );
  }
}

interface GithubPage {
  value: unknown;
  next: string | null;
  bytes: number;
}

interface GithubReader {
  read(url: string): Promise<GithubPage>;
}

function patGithubReader(fetcher: Fetcher, accessToken: string): GithubReader {
  return {
    async read(url) {
      const result = await githubJson(fetcher, url, accessToken);
      return {
        value: result.value,
        next: nextLink(result.response.headers.get("link")),
        bytes: result.bytes,
      };
    },
  };
}

function pluginGithubReader(plugin: PluginGithubProvider): GithubReader {
  return {
    async read(value) {
      const url = new URL(value, API);
      if (url.origin !== API) {
        throw new GithubConnectionError("GitHub URL is invalid.", "github_url_invalid");
      }
      const result = await plugin.request({
        method: "GET",
        path: `${url.pathname}${url.search}`,
      });
      const bytes = Buffer.byteLength(JSON.stringify(result.data));
      if (bytes > MAX_GITHUB_PAGE_BYTES) {
        throw new GithubConnectionError(
          "GitHub returned a page larger than 10 MB.",
          "github_too_large",
          422,
        );
      }
      return { value: result.data, next: result.next, bytes };
    },
  };
}

async function verifyRepository(reader: GithubReader, repository: string): Promise<string> {
  const { value } = await reader.read(`${API}/repos/${repository}`);
  const fullName = (value as { full_name?: unknown })?.full_name;
  if (typeof fullName !== "string" || fullName.toLowerCase() !== repository) {
    throw new GithubConnectionError(
      "GitHub returned a different repository.",
      "repository_mismatch",
      502,
    );
  }
  const defaultBranch = (value as { default_branch?: unknown })?.default_branch;
  if (typeof defaultBranch !== "string" || !defaultBranch.trim()) {
    throw new GithubConnectionError(
      "GitHub returned no default branch for this repository.",
      "github_response_invalid",
      502,
    );
  }
  return defaultBranch;
}

async function existingCollection(
  client: PoolClient,
  workspaceId: string,
  templateHandle: string,
): Promise<{ collectionId: string; handle: string } | null> {
  const found = await client.query<{ id: string; handle: string }>(
    `SELECT id, handle FROM collections
      WHERE workspace_id = $1 AND data->>'template_handle' = $2 AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`,
    [workspaceId, templateHandle],
  );
  const row = found.rows[0];
  return row ? { collectionId: row.id, handle: row.handle } : null;
}

async function ensureCollection(
  client: PoolClient,
  input: {
    workspaceId: string;
    workspaceHandle: string;
    userId: string;
    templateHandle: "github-issues" | "github-pull-requests" | "codebase";
  },
): Promise<{ collectionId: string; handle: string }> {
  return (
    (await existingCollection(client, input.workspaceId, input.templateHandle)) ??
    createCollectionInWorkspace(
      {
        workspaceId: input.workspaceId,
        requestedHandle: `${input.workspaceHandle}-${input.templateHandle}`,
        createdByUserId: input.userId,
        templateHandle: input.templateHandle,
      },
      client,
    )
  );
}

async function summary(client: PoolClient, connectionId: string): Promise<GithubConnectionSummary> {
  const found = await client.query<{
    id: string;
    repository: string;
    issues_handle: string;
    pulls_handle: string;
    code_handle: string;
    active: boolean;
    last_synced_at: Date | string | null;
    last_error: string | null;
    webhook_id: string | number | null;
    webhook_url: string | null;
    webhook_last_delivery_at: Date | string | null;
    plugin_installation_id: string | null;
  }>(
    `SELECT g.id, g.repository, i.handle AS issues_handle, p.handle AS pulls_handle,
            c.handle AS code_handle,
            g.active, g.last_synced_at, g.last_error, g.webhook_id, g.webhook_url,
            g.webhook_last_delivery_at, g.plugin_installation_id
       FROM github_connections g
       JOIN collections i ON i.id = g.issues_collection_id
       JOIN collections p ON p.id = g.pull_requests_collection_id
       JOIN collections c ON c.id = g.code_collection_id
      WHERE g.id = $1`,
    [connectionId],
  );
  const row = found.rows[0];
  if (!row)
    throw new GithubConnectionError("GitHub connection not found.", "connection_not_found", 404);
  return {
    id: row.id,
    repository: row.repository,
    issuesCollectionHandle: row.issues_handle,
    pullRequestsCollectionHandle: row.pulls_handle,
    codeCollectionHandle: row.code_handle,
    active: row.active,
    gatewayConnected: row.plugin_installation_id !== null,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastError: row.last_error,
    webhookConfigured: row.webhook_id !== null && Boolean(row.webhook_url),
    webhookUrl: row.webhook_url,
    webhookLastDeliveryAt: row.webhook_last_delivery_at
      ? new Date(row.webhook_last_delivery_at).toISOString()
      : null,
  };
}

async function githubMutation(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
  method: "POST" | "PATCH" | "DELETE",
  body?: Record<string, unknown>,
  operation: "configure" | "delete" = "configure",
): Promise<unknown> {
  const response = await githubFetch(fetcher, url, {
    method,
    headers: { ...headers(accessToken), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (operation === "delete" && response.status === 404) return null;
  if (!response.ok) {
    if (operation === "delete") {
      throw new GithubConnectionError(
        response.status === 401 || response.status === 403
          ? "GitHub rejected webhook deletion. Keep Webhooks repository write access until disconnect completes."
          : `GitHub returned ${response.status} while deleting the repository webhook.`,
        "github_webhook_delete_failed",
        502,
      );
    }
    const message =
      response.status === 401 || response.status === 403
        ? "GitHub rejected webhook setup. Grant the token Webhooks repository write access."
        : `GitHub returned ${response.status} while configuring automatic sync.`;
    throw new GithubConnectionError(message, "github_webhook_setup_failed", 502);
  }
  if (response.status === 204) return null;
  return response.json();
}

function githubWebhookUrl(publicHost: string, connectionId: string): string {
  let url: URL;
  try {
    url = new URL(publicHost);
  } catch {
    throw new GithubConnectionError(
      "DOCO_PUBLIC_HOST must be a valid HTTPS URL before automatic GitHub sync can be enabled.",
      "public_host_invalid",
    );
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new GithubConnectionError(
      "DOCO_PUBLIC_HOST must be a public HTTPS URL before automatic GitHub sync can be enabled.",
      "public_host_invalid",
    );
  }
  return `${url.origin}/api/v1/github/webhooks/${connectionId}`;
}

/** Register or rotate the repository webhook that turns GitHub events into a full, idempotent sync. */
export async function configureGithubWebhook(
  withClient: ClientScope,
  input: {
    connectionId: string;
    userId: string;
    publicHost: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubConnectionSummary> {
  const webhookUrl = githubWebhookUrl(input.publicHost, input.connectionId);
  const webhookSecret = randomBytes(32).toString("base64url");
  const secretSealed = sealSecret(webhookSecret, input.encryptionKey);
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    userId: input.userId,
  });
  try {
    if (!claimed.connection.token_sealed) {
      throw new GithubConnectionError(
        "The Braino GitHub App already provides automatic sync.",
        "github_app_managed",
        409,
      );
    }
    const accessToken = openSecret(claimed.connection.token_sealed, input.encryptionKey);
    await withClient(async (client) => {
      const saved = await client.query(
        `UPDATE github_connections
            SET webhook_secret_sealed = $2, webhook_url = $3
          WHERE id = $1 AND sync_token = $4
        RETURNING id`,
        [claimed.connection.id, secretSealed, webhookUrl, claimed.syncToken],
      );
      if (!saved.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
    });
    const body = {
      name: "web",
      config: {
        url: webhookUrl,
        content_type: "json",
        secret: webhookSecret,
        insecure_ssl: "0",
      },
      events: ["issues", "pull_request", "push"],
      active: true,
    };
    const remote = (await githubMutation(
      input.fetcher ?? fetch,
      claimed.connection.webhook_id
        ? `${API}/repos/${claimed.connection.repository}/hooks/${claimed.connection.webhook_id}`
        : `${API}/repos/${claimed.connection.repository}/hooks`,
      accessToken,
      claimed.connection.webhook_id ? "PATCH" : "POST",
      body,
    )) as { id?: unknown } | null;
    const webhookId = claimed.connection.webhook_id ?? remote?.id;
    if (typeof webhookId !== "number" && typeof webhookId !== "string") {
      throw new GithubConnectionError(
        "GitHub returned an invalid webhook identity.",
        "github_response_invalid",
        502,
      );
    }
    return withClient(async (client) => {
      const saved = await client.query(
        `UPDATE github_connections
            SET webhook_id = $2, webhook_created_at = coalesce(webhook_created_at, now()),
                last_error = NULL, sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $3
        RETURNING id`,
        [claimed.connection.id, webhookId, claimed.syncToken],
      );
      if (!saved.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
      return summary(client, claimed.connection.id);
    });
  } catch (error) {
    await withClient((client) =>
      client.query(
        `UPDATE github_connections
            SET webhook_secret_sealed = $2, webhook_url = $3, last_error = $4,
                sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $5`,
        [
          claimed.connection.id,
          claimed.connection.webhook_secret_sealed,
          claimed.connection.webhook_url,
          error instanceof Error ? error.message.slice(0, 500) : "GitHub webhook setup failed.",
          claimed.syncToken,
        ],
      ),
    );
    throw error;
  }
}

export interface GithubWebhookDeliveryResult {
  event: string;
  synced: boolean;
  replayed: boolean;
  created: number;
  updated: number;
  unchanged: number;
}

function verifyGithubSignature(body: string, signature: string, secret: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  const actualBytes = Buffer.from(signature, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new GithubConnectionError(
      "GitHub webhook signature is invalid.",
      "signature_invalid",
      401,
    );
  }
}

/** Validate, deduplicate, and apply one signed GitHub delivery. */
export async function deliverGithubWebhook(
  withClient: ClientScope,
  input: {
    connectionId: string;
    deliveryId: string;
    event: string;
    signature: string;
    body: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubWebhookDeliveryResult> {
  const deliveryId = input.deliveryId.trim().slice(0, 200);
  const event = input.event.trim().slice(0, 100);
  if (!deliveryId || !event) {
    throw new GithubConnectionError("GitHub delivery headers are required.", "headers_required");
  }
  const reservation = await withClient(async (client) => {
    const found = await client.query<ConnectionRow>(
      "SELECT * FROM github_connections WHERE id = $1",
      [input.connectionId],
    );
    const connection = found.rows[0];
    if (!connection || !connection.active || !connection.webhook_secret_sealed) {
      throw new GithubConnectionError("GitHub webhook is not active.", "webhook_inactive", 404);
    }
    const webhookSecret = openSecret(connection.webhook_secret_sealed, input.encryptionKey);
    verifyGithubSignature(input.body, input.signature.trim(), webhookSecret);
    let payload: unknown;
    try {
      payload = JSON.parse(input.body);
    } catch {
      throw new GithubConnectionError("GitHub webhook payload is invalid.", "payload_invalid");
    }
    const repository =
      payload && typeof payload === "object"
        ? (payload as { repository?: { full_name?: unknown } }).repository?.full_name
        : null;
    if (typeof repository !== "string" || repository.toLowerCase() !== connection.repository) {
      throw new GithubConnectionError(
        "GitHub webhook repository does not match this connection.",
        "repository_mismatch",
        403,
      );
    }
    const reserved = await client.query(
      `INSERT INTO github_webhook_deliveries (connection_id, delivery_id, event, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT DO NOTHING
       RETURNING delivery_id`,
      [connection.id, deliveryId, event],
    );
    if (!reserved.rows[0]) {
      const prior = await client.query<{
        status: string;
        response: GithubWebhookDeliveryResult | null;
      }>(
        `SELECT status, response FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2`,
        [connection.id, deliveryId],
      );
      if (prior.rows[0]?.status === "completed" && prior.rows[0].response) {
        return { replay: { ...prior.rows[0].response, replayed: true } };
      }
      throw new GithubConnectionError(
        "This GitHub delivery is already processing.",
        "delivery_in_progress",
        409,
      );
    }
    return { connectionId: connection.id };
  });
  if ("replay" in reservation) return reservation.replay;
  try {
    const supported = event === "issues" || event === "pull_request" || event === "push";
    const synced = supported
      ? await syncGithubConnection(withClient, {
          connectionId: reservation.connectionId,
          encryptionKey: input.encryptionKey,
          ...(input.fetcher ? { fetcher: input.fetcher } : {}),
        })
      : { created: 0, updated: 0, unchanged: 0 };
    const result: GithubWebhookDeliveryResult = {
      event,
      synced: supported,
      replayed: false,
      ...synced,
    };
    await withClient(async (client) => {
      await client.query(
        `UPDATE github_webhook_deliveries
            SET status = 'completed', response = $3::jsonb, completed_at = now()
          WHERE connection_id = $1 AND delivery_id = $2`,
        [reservation.connectionId, deliveryId, JSON.stringify(result)],
      );
      await client.query(
        "UPDATE github_connections SET webhook_last_delivery_at = now() WHERE id = $1",
        [reservation.connectionId],
      );
    });
    return result;
  } catch (error) {
    await withClient((client) =>
      client.query(
        `DELETE FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2 AND status = 'processing'`,
        [reservation.connectionId, deliveryId],
      ),
    );
    throw error;
  }
}

async function saveGithubConnection(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    repository: string;
    tokenSealed: string | null;
    pluginInstallationId: string | null;
  },
): Promise<GithubConnectionSummary> {
  return withClient(async (client) => {
    await requireOwner(client, input.workspaceId, input.userId);
    const current = await client.query<ConnectionRow>(
      "SELECT * FROM github_connections WHERE workspace_id = $1",
      [input.workspaceId],
    );
    const existing = current.rows[0];
    if (existing) {
      if (existing.repository !== input.repository) {
        throw new GithubConnectionError(
          `This workspace is already connected to ${existing.repository}.`,
          "source_already_connected",
          409,
        );
      }
      await client.query(
        `UPDATE github_connections
            SET token_sealed = COALESCE($2, token_sealed),
                plugin_installation_id = $3,
                active = true, last_error = NULL
          WHERE id = $1`,
        [existing.id, input.tokenSealed, input.pluginInstallationId],
      );
      return summary(client, existing.id);
    }

    await client.query("BEGIN");
    try {
      const workspace = await client.query<{ handle: string }>(
        "SELECT handle FROM workspaces WHERE id = $1",
        [input.workspaceId],
      );
      const workspaceHandle = workspace.rows[0]?.handle;
      if (!workspaceHandle)
        throw new GithubConnectionError("Workspace not found.", "workspace_not_found", 404);
      const issues = await ensureCollection(client, {
        workspaceId: input.workspaceId,
        workspaceHandle,
        userId: input.userId,
        templateHandle: "github-issues",
      });
      const pulls = await ensureCollection(client, {
        workspaceId: input.workspaceId,
        workspaceHandle,
        userId: input.userId,
        templateHandle: "github-pull-requests",
      });
      const code = await ensureCollection(client, {
        workspaceId: input.workspaceId,
        workspaceHandle,
        userId: input.userId,
        templateHandle: "codebase",
      });
      await client.query(
        `UPDATE collections
            SET data = jsonb_set(
              data || '{"github_integration": {}}'::jsonb,
              '{github_integration,connections}',
              jsonb_build_array(jsonb_build_object('repo', $2::text)),
              true
            ),
                updated_at = now()
          WHERE id = $1`,
        [code.collectionId, input.repository],
      );
      const id = `github_${generateUlid()}`;
      await client.query(
        `INSERT INTO github_connections
           (id, workspace_id, repository, token_sealed, plugin_installation_id,
            issues_collection_id, pull_requests_collection_id, code_collection_id,
            created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          input.workspaceId,
          input.repository,
          input.tokenSealed,
          input.pluginInstallationId,
          issues.collectionId,
          pulls.collectionId,
          code.collectionId,
          input.userId,
        ],
      );
      await client.query("COMMIT");
      return summary(client, id);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

/** Legacy PAT creation remains only so an existing connection can reach the App cutover UI. */
export async function connectGithubRepository(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    repository: string;
    accessToken: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<GithubConnectionSummary> {
  await withClient((client) => requireOwner(client, input.workspaceId, input.userId));
  const repository = normalizeRepository(input.repository);
  const accessToken = input.accessToken.trim();
  if (!accessToken) throw new GithubConnectionError("GitHub token is required.", "token_required");
  await verifyRepository(patGithubReader(input.fetcher ?? fetch, accessToken), repository);
  return saveGithubConnection(withClient, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    repository,
    tokenSealed: sealSecret(accessToken, input.encryptionKey),
    pluginInstallationId: null,
  });
}

/** Attach the scoped gateway plugin; the PAT is deleted only after a successful sync. */
export async function connectGithubRepositoryWithPlugin(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    repository: string;
    plugin: PluginGithubProvider;
  },
): Promise<GithubConnectionSummary> {
  await withClient((client) => requireOwner(client, input.workspaceId, input.userId));
  const repository = normalizeRepository(input.repository);
  if (input.plugin.installation.workspaceId !== input.workspaceId) {
    throw new GithubConnectionError(
      "GitHub plugin belongs to another workspace.",
      "installation_unavailable",
      404,
    );
  }
  const available = await input.plugin.repositories();
  if (!available.some((candidate) => candidate.fullName.toLowerCase() === repository)) {
    throw new GithubConnectionError(
      "The GitHub App installation does not include that repository.",
      "repository_not_installed",
      403,
    );
  }
  await verifyRepository(pluginGithubReader(input.plugin), repository);
  return saveGithubConnection(withClient, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    repository,
    tokenSealed: null,
    pluginInstallationId: input.plugin.installation.installationId,
  });
}

export async function finishGithubGatewayMigration(
  withClient: ClientScope,
  input: { connectionId: string; pluginInstallationId: string },
): Promise<GithubConnectionSummary> {
  return withClient(async (client) => {
    const migrated = await client.query(
      `UPDATE github_connections
          SET token_sealed = NULL,
              webhook_id = NULL,
              webhook_secret_sealed = NULL,
              webhook_url = NULL,
              webhook_created_at = NULL,
              last_error = NULL
        WHERE id = $1 AND plugin_installation_id = $2 AND active
      RETURNING id`,
      [input.connectionId, input.pluginInstallationId],
    );
    if (!migrated.rows[0]) {
      throw new GithubConnectionError(
        "GitHub connection changed during migration.",
        "connection_changed",
        409,
      );
    }
    return summary(client, input.connectionId);
  });
}

export async function listGithubConnections(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<GithubConnectionSummary[]> {
  await requireOwner(client, workspaceId, userId);
  const found = await client.query<{ id: string }>(
    "SELECT id FROM github_connections WHERE workspace_id = $1 ORDER BY created_at",
    [workspaceId],
  );
  return Promise.all(found.rows.map((row) => summary(client, row.id)));
}

const BRIEF_TRAILER = /(?:Doco|Braino)-Brief:\s*https?:\/\/\S+/i;
const BRAINO_RECORD =
  /\b(?:intent|idea|rule|decision|action|log|eval|reference|state|principal|policy|brief)_[0-9A-HJKMNP-TV-Z]{26}\b/i;

export function pullRequestWentThroughBraino(input: {
  body: string | null;
  commitMessages: readonly string[];
}): boolean {
  return [input.body ?? "", ...input.commitMessages].some(
    (value) => BRIEF_TRAILER.test(value) || BRAINO_RECORD.test(value),
  );
}

interface PullRequestVerdictRow {
  went_through_braino: boolean;
  review_status: "processing" | "completed" | null;
  brief_id: string | null;
  brief_status: "processing" | "completed" | null;
}

async function storedPullRequestVerdict(
  withClient: ClientScope,
  connectionId: string,
  pullNumber: number,
): Promise<PullRequestVerdictRow | null> {
  return withClient(async (client) => {
    const found = await client.query<PullRequestVerdictRow>(
      `SELECT went_through_braino, review_status, brief_id, brief_status
         FROM github_pull_request_verdicts
        WHERE connection_id = $1 AND pull_number = $2`,
      [connectionId, pullNumber],
    );
    return found.rows[0] ?? null;
  });
}

async function freezePullRequestVerdict(
  withClient: ClientScope,
  input: { connectionId: string; pullNumber: number; wentThroughBraino: boolean },
): Promise<PullRequestVerdictRow> {
  return withClient(async (client) => {
    await client.query(
      `INSERT INTO github_pull_request_verdicts
         (connection_id, pull_number, went_through_braino)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [input.connectionId, input.pullNumber, input.wentThroughBraino],
    );
    const found = await client.query<PullRequestVerdictRow>(
      `SELECT went_through_braino, review_status, brief_id, brief_status
         FROM github_pull_request_verdicts
        WHERE connection_id = $1 AND pull_number = $2`,
      [input.connectionId, input.pullNumber],
    );
    const row = found.rows[0];
    if (!row) throw new Error("GitHub pull-request verdict was not stored.");
    return row;
  });
}

async function judgePullRequest(
  withClient: ClientScope,
  input: {
    connectionId: string;
    repository: string;
    pullNumber: number;
    body: string | null;
    plugin: PluginGithubProvider;
  },
): Promise<PullRequestVerdictRow | null> {
  const stored = await storedPullRequestVerdict(withClient, input.connectionId, input.pullNumber);
  if (stored) return stored;

  let wentThroughBraino = pullRequestWentThroughBraino({
    body: input.body,
    commitMessages: [],
  });
  if (!wentThroughBraino) {
    let commitMessages: readonly string[];
    try {
      commitMessages = await input.plugin.pullRequestCommits(input.repository, input.pullNumber);
    } catch {
      // An unreadable provenance source is not evidence of failure. Do not
      // freeze a verdict until GitHub lets Braino inspect the commits.
      return null;
    }
    wentThroughBraino = pullRequestWentThroughBraino({
      body: input.body,
      commitMessages,
    });
  }
  return freezePullRequestVerdict(withClient, {
    connectionId: input.connectionId,
    pullNumber: input.pullNumber,
    wentThroughBraino,
  });
}

async function rejectPullRequestOnce(
  withClient: ClientScope,
  input: {
    connectionId: string;
    repository: string;
    pullNumber: number;
    headSha: string;
    plugin: PluginGithubProvider;
  },
): Promise<void> {
  const claimed = await withClient(async (client) => {
    const result = await client.query(
      `UPDATE github_pull_request_verdicts
          SET review_status = 'processing', review_started_at = now(), updated_at = now()
        WHERE connection_id = $1 AND pull_number = $2
          AND NOT went_through_braino
          AND (
            review_status IS NULL OR (
              review_status = 'processing'
              AND review_started_at < now() - interval '5 minutes'
            )
          )
      RETURNING connection_id`,
      [input.connectionId, input.pullNumber],
    );
    return Boolean(result.rows[0]);
  });
  if (!claimed) return;

  try {
    const review = await input.plugin.rejectPullRequest({
      repository: input.repository,
      pullNumber: input.pullNumber,
      commitId: input.headSha,
      body: [
        "Braino found no provenance evidence when this pull request was first checked.",
        "This verdict is permanent for this pull request. Close it and open a new pull request after working through Braino.",
      ].join("\n\n"),
    });
    await withClient((client) =>
      client.query(
        `UPDATE github_pull_request_verdicts
            SET review_status = 'completed', review_id = $3, updated_at = now()
          WHERE connection_id = $1 AND pull_number = $2
            AND review_status = 'processing'`,
        [input.connectionId, input.pullNumber, review.id],
      ),
    );
  } catch (error) {
    await withClient((client) =>
      client.query(
        `UPDATE github_pull_request_verdicts
            SET review_status = NULL, review_started_at = NULL, updated_at = now()
          WHERE connection_id = $1 AND pull_number = $2
            AND review_status = 'processing'`,
        [input.connectionId, input.pullNumber],
      ),
    );
    throw error;
  }
}

function publicBrainoOrigin(): string {
  const configured = process.env.DOCO_PUBLIC_HOST?.trim();
  if (!configured) throw new Error("DOCO_PUBLIC_HOST is required to publish a Braino brief.");
  const origin = new URL(configured);
  if (origin.protocol !== "https:") {
    throw new Error("DOCO_PUBLIC_HOST must use HTTPS to publish a Braino brief.");
  }
  return origin.origin;
}

async function publishPullRequestBriefOnce(
  withClient: ClientScope,
  input: {
    connection: ConnectionRow;
    repository: string;
    pullNumber: number;
    pullTitle: string;
    pullUrl: string;
    plugin: PluginGithubProvider;
  },
): Promise<void> {
  let claimed = false;
  let briefId: string | null = null;
  let workspaceHandle: string | null = null;
  try {
    const brief = await withClient(async (client) => {
      const result = await client.query<{ brief_id: string | null }>(
        `UPDATE github_pull_request_verdicts
            SET brief_status = 'processing', brief_started_at = now(), updated_at = now()
          WHERE connection_id = $1 AND pull_number = $2
            AND went_through_braino
            AND (
              brief_status IS NULL OR (
                brief_status = 'processing'
                AND brief_started_at < now() - interval '5 minutes'
              )
            )
        RETURNING brief_id`,
        [input.connection.id, input.pullNumber],
      );
      const row = result.rows[0];
      if (!row) return null;
      claimed = true;

      if (row.brief_id) {
        const workspace = await client.query<{ handle: string }>(
          "SELECT handle FROM workspaces WHERE id = $1",
          [input.connection.workspace_id],
        );
        const handle = workspace.rows[0]?.handle;
        if (!handle) throw new Error("Braino workspace was not found.");
        return { briefId: row.brief_id, workspaceHandle: handle };
      }

      const created = await createWorkspaceBrief(client, {
        workspaceId: input.connection.workspace_id,
        userId: input.connection.created_by_user_id,
        agentLabel: "Braino GitHub App",
        about: `Pull request #${input.pullNumber}: ${input.pullTitle}`,
        touching: [input.repository, input.pullUrl],
      });
      await client.query(
        `UPDATE github_pull_request_verdicts
            SET brief_id = $3, updated_at = now()
          WHERE connection_id = $1 AND pull_number = $2
            AND brief_status = 'processing'`,
        [input.connection.id, input.pullNumber, created.brief_id],
      );
      return { briefId: created.brief_id, workspaceHandle: created.workspace.handle };
    });
    if (!brief) return;
    ({ briefId, workspaceHandle } = brief);

    const briefUrl = new URL(
      `/workspaces/${encodeURIComponent(workspaceHandle)}/brief`,
      publicBrainoOrigin(),
    );
    briefUrl.searchParams.set("id", briefId);
    const comment = await input.plugin.publishPullRequestComment({
      repository: input.repository,
      pullNumber: input.pullNumber,
      body: [
        "### Braino brief",
        "This pull request went through Braino. The brief stays private to the connected Braino workspace.",
        `[Open the workspace brief](${briefUrl.toString()})`,
      ].join("\n\n"),
    });
    await withClient((client) =>
      client.query(
        `UPDATE github_pull_request_verdicts
            SET brief_status = 'completed', brief_comment_id = $3, updated_at = now()
          WHERE connection_id = $1 AND pull_number = $2
            AND brief_status = 'processing'`,
        [input.connection.id, input.pullNumber, comment.id],
      ),
    );
  } catch (error) {
    if (claimed) {
      await withClient((client) =>
        client.query(
          `UPDATE github_pull_request_verdicts
              SET brief_status = NULL, brief_started_at = NULL, updated_at = now()
            WHERE connection_id = $1 AND pull_number = $2
              AND brief_status = 'processing'`,
          [input.connection.id, input.pullNumber],
        ),
      );
    }
    throw error;
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface GithubGatewayDeliveryResult {
  event: string;
  synced: boolean;
  replayed: boolean;
  checked: boolean;
  created: number;
  updated: number;
  unchanged: number;
}

export async function deliverGithubGatewayWebhook(
  withClient: ClientScope,
  input: {
    plugin: PluginGithubProvider;
    headers: Readonly<Record<string, string>>;
    body: string;
  },
): Promise<GithubGatewayDeliveryResult> {
  const events = await input.plugin.receive({
    body: input.body,
    headers: input.headers,
    receivedAt: Math.floor(Date.now() / 1000),
  });
  const received = events[0];
  if (!received) {
    throw new GithubConnectionError("GitHub delivery contained no event.", "payload_invalid");
  }
  const repository = object(received.data.repository)?.full_name;
  if (typeof repository !== "string") {
    return {
      event: received.kind,
      synced: false,
      replayed: false,
      checked: false,
      created: 0,
      updated: 0,
      unchanged: 0,
    };
  }
  const reserved = await withClient(async (client) => {
    const found = await client.query<ConnectionRow>(
      `SELECT * FROM github_connections
        WHERE plugin_installation_id = $1
          AND lower(repository) = lower($2) AND active`,
      [input.plugin.installation.installationId, repository],
    );
    const row = found.rows[0];
    if (!row) {
      throw new GithubConnectionError(
        "GitHub delivery is for a repository this workspace does not track.",
        "connection_not_found",
        404,
      );
    }
    const inserted = await client.query(
      `INSERT INTO github_webhook_deliveries (connection_id, delivery_id, event, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT DO NOTHING
       RETURNING delivery_id`,
      [row.id, received.id.slice(0, 200), received.kind.slice(0, 100)],
    );
    if (inserted.rows[0]) return { row };
    const prior = await client.query<{
      status: string;
      response: GithubGatewayDeliveryResult | null;
    }>(
      `SELECT status, response FROM github_webhook_deliveries
        WHERE connection_id = $1 AND delivery_id = $2`,
      [row.id, received.id.slice(0, 200)],
    );
    if (prior.rows[0]?.status === "completed" && prior.rows[0].response) {
      return { replay: { ...prior.rows[0].response, replayed: true } };
    }
    throw new GithubConnectionError(
      "This GitHub delivery is already processing.",
      "delivery_in_progress",
      409,
    );
  });
  if ("replay" in reserved) return reserved.replay;

  try {
    const supported = ["issues", "pull_request", "push"].includes(received.kind);
    let checked = false;
    const pull = object(received.data.pull_request);
    const head = object(pull?.head);
    const pullNumber = Number(received.data.number ?? pull?.number);
    if (
      received.kind === "pull_request" &&
      pull?.state === "open" &&
      Number.isSafeInteger(pullNumber) &&
      pullNumber > 0 &&
      typeof head?.sha === "string"
    ) {
      const verdict = await judgePullRequest(withClient, {
        connectionId: reserved.row.id,
        repository,
        pullNumber,
        body: typeof pull.body === "string" ? pull.body : null,
        plugin: input.plugin,
      });
      const conclusion = verdict
        ? verdict.went_through_braino
          ? "success"
          : "failure"
        : "neutral";
      await input.plugin.publishCheck({
        repository,
        name: "Braino",
        headSha: head.sha,
        conclusion,
        title: verdict
          ? verdict.went_through_braino
            ? "Went through Braino"
            : "Didn't go through Braino"
          : "Not checked",
        summary: verdict
          ? verdict.went_through_braino
            ? "A pull-request commit or description cites the Braino brief or record used for this work."
            : "No Braino brief or record was present when this pull request was first checked. This verdict is permanent for this pull request."
          : "Braino could not read the pull-request commits, so no verdict was recorded. GitHub can retry this check.",
      });
      if (verdict?.went_through_braino) {
        await publishPullRequestBriefOnce(withClient, {
          connection: reserved.row,
          repository,
          pullNumber,
          pullTitle: typeof pull.title === "string" ? pull.title : `Pull request #${pullNumber}`,
          pullUrl:
            typeof pull.html_url === "string"
              ? pull.html_url
              : `https://github.com/${repository}/pull/${pullNumber}`,
          plugin: input.plugin,
        });
      } else if (verdict) {
        await rejectPullRequestOnce(withClient, {
          connectionId: reserved.row.id,
          repository,
          pullNumber,
          headSha: head.sha,
          plugin: input.plugin,
        });
      }
      checked = true;
    }
    const synced = supported
      ? await syncGithubConnection(withClient, {
          connectionId: reserved.row.id,
          plugin: input.plugin,
        })
      : { created: 0, updated: 0, unchanged: 0 };
    const result: GithubGatewayDeliveryResult = {
      event: received.kind,
      synced: supported,
      replayed: false,
      checked,
      ...synced,
    };
    await withClient(async (client) => {
      await client.query(
        `UPDATE github_webhook_deliveries
            SET status = 'completed', response = $3::jsonb, completed_at = now()
          WHERE connection_id = $1 AND delivery_id = $2`,
        [reserved.row.id, received.id.slice(0, 200), JSON.stringify(result)],
      );
      await client.query(
        "UPDATE github_connections SET webhook_last_delivery_at = now() WHERE id = $1",
        [reserved.row.id],
      );
    });
    return result;
  } catch (error) {
    await withClient((client) =>
      client.query(
        `DELETE FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2 AND status = 'processing'`,
        [reserved.row.id, received.id.slice(0, 200)],
      ),
    );
    throw error;
  }
}

export async function disconnectGithubRepository(
  withClient: ClientScope,
  input: {
    connectionId: string;
    userId: string;
    encryptionKey: string;
    fetcher?: Fetcher;
  },
): Promise<void> {
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    userId: input.userId,
  });
  try {
    if (claimed.connection.webhook_id !== null && claimed.connection.token_sealed) {
      await githubMutation(
        input.fetcher ?? fetch,
        `${API}/repos/${claimed.connection.repository}/hooks/${claimed.connection.webhook_id}`,
        openSecret(claimed.connection.token_sealed, input.encryptionKey),
        "DELETE",
        undefined,
        "delete",
      );
    }
    await withClient(async (client) => {
      const disconnected = await client.query(
        `UPDATE github_connections
            SET active = false, token_sealed = NULL, plugin_installation_id = NULL,
                webhook_id = NULL,
                webhook_secret_sealed = NULL, webhook_url = NULL, last_error = NULL,
                sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $2
        RETURNING id`,
        [claimed.connection.id, claimed.syncToken],
      );
      if (!disconnected.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation no longer owns the connection lease.",
          "sync_lease_lost",
          409,
        );
      }
    });
  } catch (error) {
    await failGithubOperation(withClient, claimed, error);
    throw error;
  }
}

function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const part of value.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchPages(reader: GithubReader, url: string): Promise<GithubItem[]> {
  const items: GithubItem[] = [];
  let bytes = 0;
  let next: string | null = url;
  for (let page = 0; next && page < 100; page += 1) {
    const pageResult = await reader.read(next);
    const { value } = pageResult;
    if (!Array.isArray(value)) {
      throw new GithubConnectionError(
        "GitHub returned an invalid list.",
        "github_response_invalid",
        502,
      );
    }
    bytes += pageResult.bytes;
    if (items.length + value.length > MAX_GITHUB_ITEMS || bytes > MAX_GITHUB_SNAPSHOT_BYTES) {
      throw new GithubConnectionError(
        "GitHub snapshot exceeded 10,000 items or 128 MB.",
        "github_too_large",
        422,
      );
    }
    items.push(...(value as GithubItem[]));
    next = pageResult.next;
  }
  if (next)
    throw new GithubConnectionError(
      "GitHub pagination exceeded 10,000 items.",
      "github_too_large",
      422,
    );
  return items;
}

interface GithubTreeEntry {
  path?: unknown;
  type?: unknown;
  sha?: unknown;
  size?: unknown;
}

interface CodeFileSnapshot {
  path: string;
  sha: string;
  size: number;
  content: string;
  omitted: "binary" | "too_large" | "unavailable" | null;
}

interface CodeSnapshot {
  paths: string[];
  changed: CodeFileSnapshot[];
}

async function storedCodeShas(
  withClient: ClientScope,
  collectionId: string,
  repository: string,
): Promise<Map<string, string>> {
  return withClient(async (client) => {
    const found = await client.query<{ path: string; sha: string }>(
      "SELECT path, sha FROM code_files WHERE collection_id = $1 AND repo = $2",
      [collectionId, repository],
    );
    return new Map(found.rows.map((row) => [row.path, row.sha]));
  });
}

function decodedBlob(value: unknown, path: string): { content: string; omitted: "binary" | null } {
  if (!value || typeof value !== "object") {
    throw new GithubConnectionError(
      "GitHub returned an invalid code blob.",
      "github_response_invalid",
      502,
    );
  }
  const blob = value as { encoding?: unknown; content?: unknown };
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new GithubConnectionError(
      "GitHub returned an invalid code blob.",
      "github_response_invalid",
      502,
    );
  }
  const bytes = Buffer.from(blob.content.replaceAll(/\s/g, ""), "base64");
  if (bytes.includes(0)) return { content: "", omitted: "binary" };
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\u0000", ""),
      omitted: null,
    };
  } catch {
    console.info(`[github] keeping binary file by name only: ${path}`);
    return { content: "", omitted: "binary" };
  }
}

async function fetchCodeSnapshot(
  reader: GithubReader,
  repository: string,
  stored: Map<string, string>,
): Promise<CodeSnapshot> {
  const defaultBranch = await verifyRepository(reader, repository);
  const { value } = await reader.read(
    `${API}/repos/${repository}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
  );
  const tree = value as { truncated?: unknown; tree?: unknown };
  if (!tree || tree.truncated === true || !Array.isArray(tree.tree)) {
    throw new GithubConnectionError(
      "GitHub could not provide a complete repository tree.",
      "github_tree_incomplete",
      422,
    );
  }
  const files = (tree.tree as GithubTreeEntry[])
    .filter((entry) => entry.type === "blob")
    .map((entry) => {
      if (
        typeof entry.path !== "string" ||
        typeof entry.sha !== "string" ||
        typeof entry.size !== "number" ||
        !Number.isInteger(entry.size) ||
        entry.size < 0
      ) {
        throw new GithubConnectionError(
          "GitHub returned an invalid repository tree.",
          "github_response_invalid",
          502,
        );
      }
      return { path: entry.path, sha: entry.sha, size: entry.size };
    });
  if (files.length > MAX_GITHUB_ITEMS) {
    throw new GithubConnectionError(
      "GitHub repository exceeded 10,000 files.",
      "github_too_large",
      422,
    );
  }

  const changed: CodeFileSnapshot[] = [];
  const pending = files.filter((file) => stored.get(file.path) !== file.sha);
  for (let offset = 0; offset < pending.length; offset += GITHUB_BLOB_CONCURRENCY) {
    const batch = pending.slice(offset, offset + GITHUB_BLOB_CONCURRENCY);
    const rows = await Promise.all(
      batch.map(async (file): Promise<CodeFileSnapshot> => {
        if (file.size > MAX_CODE_FILE_BYTES) {
          return { ...file, content: "", omitted: "too_large" };
        }
        try {
          const blob = await reader.read(`${API}/repos/${repository}/git/blobs/${file.sha}`);
          return { ...file, ...decodedBlob(blob.value, file.path) };
        } catch (error) {
          if (error instanceof GithubConnectionError) throw error;
          return { ...file, content: "", omitted: "unavailable" };
        }
      }),
    );
    changed.push(...rows);
  }
  return { paths: files.map((file) => file.path), changed };
}

async function applyCodeSnapshot(
  client: PoolClient,
  connection: ConnectionRow,
  snapshot: CodeSnapshot,
): Promise<void> {
  if (snapshot.changed.length > 0) {
    await client.query(
      `INSERT INTO code_files (collection_id, repo, path, sha, size, content, omitted, synced_at)
       SELECT $1, $2, files.path, files.sha, files.size, files.content, files.omitted, now()
         FROM unnest($3::text[], $4::text[], $5::int[], $6::text[], $7::text[])
              AS files(path, sha, size, content, omitted)
       ON CONFLICT (collection_id, repo, path) DO UPDATE
          SET sha = EXCLUDED.sha,
              size = EXCLUDED.size,
              content = EXCLUDED.content,
              omitted = EXCLUDED.omitted,
              synced_at = EXCLUDED.synced_at`,
      [
        connection.code_collection_id,
        connection.repository,
        snapshot.changed.map((file) => file.path),
        snapshot.changed.map((file) => file.sha),
        snapshot.changed.map((file) => file.size),
        snapshot.changed.map((file) => file.content),
        snapshot.changed.map((file) => file.omitted),
      ],
    );
  }
  await client.query(
    `DELETE FROM code_files
      WHERE collection_id = $1 AND repo = $2 AND NOT (path = ANY($3::text[]))`,
    [connection.code_collection_id, connection.repository, snapshot.paths],
  );
}

function labels(item: GithubItem): string[] {
  return (item.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label.name))
    .filter((label): label is string => Boolean(label));
}

function prose(item: GithubItem): string {
  const title = `#${item.number} ${item.title}`;
  return item.body?.trim() ? `${title}\n\n${item.body.trim()}` : title;
}

function issueFields(item: GithubItem, connection: ConnectionRow): Record<string, unknown> {
  return {
    node_type: "eval",
    collection_id: connection.issues_collection_id,
    lifecycle: item.state === "closed" ? "retired" : "active",
    prose: prose(item),
    kind: "github_issue",
    locator: item.html_url,
    github_repository: connection.repository,
    github_number: item.number,
    github_state: item.state,
    github_author: item.user?.login ?? null,
    github_labels: labels(item),
    github_comments: item.comments ?? 0,
    github_locked: item.locked ?? false,
    github_created_at: item.created_at,
    github_updated_at: item.updated_at,
  };
}

function pullFields(item: GithubItem, connection: ConnectionRow): Record<string, unknown> {
  const lifecycle = item.merged_at ? "active" : item.state === "closed" ? "retired" : "drafting";
  return {
    node_type: "reference",
    collection_id: connection.pull_requests_collection_id,
    lifecycle,
    prose: prose(item),
    locator: item.html_url,
    github_repository: connection.repository,
    github_number: item.number,
    github_state: item.state,
    github_author: item.user?.login ?? null,
    github_labels: labels(item),
    github_draft: item.draft ?? false,
    github_merged_at: item.merged_at ?? null,
    github_head: item.head?.ref ?? null,
    github_base: item.base?.ref ?? null,
    github_created_at: item.created_at,
    github_updated_at: item.updated_at,
  };
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}

function storedFields(node: StoredNode, collectionId: string): Record<string, unknown> {
  return {
    ...node.extra,
    id: node.id,
    node_type: node.node_type,
    collection_id: collectionId,
    lifecycle: node.lifecycle,
    prose: node.prose,
    ...(node.kind ? { kind: node.kind } : {}),
    ...(node.locator ? { locator: node.locator } : {}),
    created_at: iso(node.created_at),
    created_by: node.created_by,
    updated_at: iso(node.updated_at),
    updated_by: node.updated_by,
  };
}

function sameNode(node: StoredNode, fields: Record<string, unknown>): boolean {
  const desired = nodeRowFromFields(String(fields.node_type), fields);
  return (
    node.node_type === fields.node_type &&
    node.lifecycle === fields.lifecycle &&
    node.prose === fields.prose &&
    node.kind === (fields.kind ?? null) &&
    node.locator === (fields.locator ?? null) &&
    stable(node.extra) === stable(desired.extra)
  );
}

async function importItems(
  client: PoolClient,
  connection: ConnectionRow,
  collectionId: string,
  nodeType: "eval" | "reference",
  actorId: string,
  items: GithubItem[],
  fieldsFor: (item: GithubItem, connection: ConnectionRow) => Record<string, unknown>,
): Promise<{ created: number; updated: number; unchanged: number }> {
  const counts = { created: 0, updated: 0, unchanged: 0 };
  let txId: number | null = null;
  for (const item of items) {
    if (
      !Number.isInteger(item.number) ||
      !item.html_url ||
      !item.title ||
      !item.created_at ||
      !item.updated_at
    ) {
      throw new GithubConnectionError(
        "GitHub returned an incomplete item.",
        "github_response_invalid",
        502,
      );
    }
    const found = await client.query<StoredNode>(
      `SELECT id, node_type, lifecycle, prose, kind, locator, extra,
              created_at, created_by, updated_at, updated_by
         FROM nodes WHERE collection_id = $1 AND locator = $2 LIMIT 1 FOR UPDATE`,
      [collectionId, item.html_url],
    );
    const before = found.rows[0];
    const imported = fieldsFor(item, connection);
    if (before && sameNode(before, imported)) {
      counts.unchanged += 1;
      continue;
    }
    txId ??= await createChangeset(client, {
      collectionId,
      actor: actorId,
      source: "import",
      reason: `Sync GitHub ${connection.repository}`,
      metadata: { integration: "github", repository: connection.repository },
    });
    const timestamp = item.updated_at;
    const fields: Record<string, unknown> = {
      ...imported,
      id: before?.id ?? makeEntityId(nodeType, generateUlid()),
      created_at: before ? iso(before.created_at) : item.created_at,
      created_by: before?.created_by ?? actorId,
      updated_at: timestamp,
      updated_by: actorId,
    };
    await upsertNode(nodeRowFromFields(nodeType, fields), client);
    await appendNodeVersion(client, {
      entityId: String(fields.id),
      entityType: nodeType,
      op: before ? "update" : "create",
      payload: fields,
      txId,
      actor: actorId,
    });
    await appendAuditEventRow(
      {
        event_id: `evt_${generateUlid()}`,
        at: timestamp,
        by_user: actorId,
        collection_id: collectionId,
        workspace_id: connection.workspace_id,
        entity_type: nodeType,
        entity_id: String(fields.id),
        op: before ? "entity.update" : "entity.create",
        before_json: before ? storedFields(before, collectionId) : null,
        after_json: fields,
        reason: `Sync GitHub ${connection.repository}`,
      },
      client,
    );
    counts[before ? "updated" : "created"] += 1;
  }
  return counts;
}

export async function syncGithubConnection(
  withClient: ClientScope,
  input: {
    connectionId: string;
    encryptionKey?: string;
    plugin?: PluginGithubProvider;
    userId?: string;
    fetcher?: Fetcher;
    codeGraphClient?: CodeGraphClient | null;
  },
): Promise<{ created: number; updated: number; unchanged: number }> {
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    ...(input.userId ? { userId: input.userId } : {}),
  });
  try {
    const reader = input.plugin
      ? pluginGithubReader(input.plugin)
      : claimed.connection.token_sealed && input.encryptionKey
        ? patGithubReader(
            input.fetcher ?? fetch,
            openSecret(claimed.connection.token_sealed, input.encryptionKey),
          )
        : null;
    if (!reader) {
      throw new GithubConnectionError(
        "Install the Braino GitHub App before syncing this connection.",
        "github_app_required",
        409,
      );
    }
    if (
      input.plugin &&
      claimed.connection.plugin_installation_id !== input.plugin.installation.installationId
    ) {
      throw new GithubConnectionError(
        "GitHub plugin does not match this connection.",
        "installation_unavailable",
        404,
      );
    }
    const stored = await storedCodeShas(
      withClient,
      claimed.connection.code_collection_id,
      claimed.connection.repository,
    );
    const [issues, pulls, codeSnapshot] = await Promise.all([
      fetchPages(
        reader,
        `${API}/repos/${claimed.connection.repository}/issues?state=all&per_page=100`,
      ),
      fetchPages(
        reader,
        `${API}/repos/${claimed.connection.repository}/pulls?state=all&per_page=100`,
      ),
      fetchCodeSnapshot(reader, claimed.connection.repository, stored),
    ]);
    const result = await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const locked = await client.query<ConnectionRow>(
          "SELECT * FROM github_connections WHERE id = $1 FOR UPDATE",
          [claimed.connection.id],
        );
        const current = locked.rows[0];
        if (
          !current ||
          !current.active ||
          (!current.token_sealed && !current.plugin_installation_id)
        ) {
          throw new GithubConnectionError(
            "GitHub connection is not active.",
            "connection_inactive",
            409,
          );
        }
        if (current.sync_token !== claimed.syncToken) {
          throw new GithubConnectionError(
            "This GitHub operation was superseded by a newer run.",
            "sync_superseded",
            409,
          );
        }
        const issueResult = await importItems(
          client,
          current,
          current.issues_collection_id,
          "eval",
          current.created_by_user_id,
          issues.filter((item) => !item.pull_request),
          issueFields,
        );
        const pullResult = await importItems(
          client,
          current,
          current.pull_requests_collection_id,
          "reference",
          current.created_by_user_id,
          pulls,
          pullFields,
        );
        await applyCodeSnapshot(client, current, codeSnapshot);
        await client.query("COMMIT");
        return {
          created: issueResult.created + pullResult.created,
          updated: issueResult.updated + pullResult.updated,
          unchanged: issueResult.unchanged + pullResult.unchanged,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
    const codeGraphClient =
      input.codeGraphClient === undefined ? configuredCodeGraphClient() : input.codeGraphClient;
    if (codeGraphClient) {
      await withClient(async (client) => {
        await syncCodeGraphRepository(client, {
          collectionId: claimed.connection.code_collection_id,
          repo: claimed.connection.repository,
          client: codeGraphClient,
        });
        await syncCodeGraphCollection(client, {
          collectionId: claimed.connection.code_collection_id,
          client: codeGraphClient,
        });
      });
    }
    await withClient(async (client) => {
      const finalized = await client.query(
        `UPDATE github_connections
            SET last_synced_at = now(), last_error = NULL,
                sync_token = NULL, sync_started_at = NULL
          WHERE id = $1 AND sync_token = $2
        RETURNING id`,
        [claimed.connection.id, claimed.syncToken],
      );
      if (!finalized.rows[0]) {
        throw new GithubConnectionError(
          "This GitHub operation was superseded by a newer run.",
          "sync_superseded",
          409,
        );
      }
    });
    return result;
  } catch (error) {
    await failGithubOperation(withClient, claimed, error);
    throw error;
  }
}
