import type { GithubAppConnectorPlugin } from "@doco/connector-plugins";
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
import { pluginCapability } from "@doco/plugin-runtime";
import { generateUlid, makeEntityId } from "@doco/shared";
import type { ClientScope } from "./client-scope.js";
import { createCollectionInWorkspace } from "./host.js";

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
  installationId: number | null;
  requireBraino: boolean;
  appConnected: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
  webhookLastDeliveryAt: string | null;
}

type Fetcher = typeof fetch;

interface ConnectionRow {
  id: string;
  workspace_id: string;
  repository: string;
  installation_id: number | string | null;
  require_braino: boolean;
  issues_collection_id: string;
  pull_requests_collection_id: string;
  code_collection_id: string;
  created_by_user_id: string;
  active: boolean;
  sync_token: string | null;
  sync_started_at: Date | string | null;
}

interface ClaimedConnection {
  connection: ConnectionRow & { installation_id: number | string };
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
      if (!row || !row.active || row.installation_id === null) {
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
      if (active?.installation_id === null || active?.installation_id === undefined) {
        throw new GithubConnectionError(
          "This GitHub connection already has an operation in progress.",
          "sync_in_progress",
          409,
        );
      }
      await client.query("COMMIT");
      return active as ConnectionRow & { installation_id: number | string };
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

async function verifyRepository(
  fetcher: Fetcher,
  repository: string,
  accessToken: string,
): Promise<string> {
  const { value } = await githubJson(fetcher, `${API}/repos/${repository}`, accessToken);
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
    webhook_last_delivery_at: Date | string | null;
    installation_id: number | string | null;
    require_braino: boolean;
  }>(
    `SELECT g.id, g.repository, i.handle AS issues_handle, p.handle AS pulls_handle,
            c.handle AS code_handle,
            g.active, g.last_synced_at, g.last_error,
            g.webhook_last_delivery_at, g.installation_id, g.require_braino
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
    installationId: row.installation_id === null ? null : Number(row.installation_id),
    requireBraino: row.require_braino,
    appConnected: row.installation_id !== null,
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    lastError: row.last_error,
    webhookLastDeliveryAt: row.webhook_last_delivery_at
      ? new Date(row.webhook_last_delivery_at).toISOString()
      : null,
  };
}

export async function connectGithubRepository(
  withClient: ClientScope,
  input: {
    workspaceId: string;
    userId: string;
    installationId: number;
    repository: string;
    plugin: GithubAppConnectorPlugin;
  },
): Promise<GithubConnectionSummary> {
  await withClient((client) => requireOwner(client, input.workspaceId, input.userId));
  const repository = normalizeRepository(input.repository);
  if (!Number.isInteger(input.installationId) || input.installationId <= 0) {
    throw new GithubConnectionError("GitHub installation is invalid.", "installation_invalid");
  }
  const available = await input.plugin.github.repositories(input.installationId);
  if (!available.some((candidate) => candidate.fullName.toLowerCase() === repository)) {
    throw new GithubConnectionError(
      "The GitHub App installation does not include that repository.",
      "repository_not_installed",
      403,
    );
  }
  return withClient(async (client) => {
    await requireOwner(client, input.workspaceId, input.userId);
    const current = await client.query<ConnectionRow>(
      "SELECT * FROM github_connections WHERE workspace_id = $1",
      [input.workspaceId],
    );
    const existing = current.rows[0];
    if (existing) {
      if (existing.repository !== repository) {
        throw new GithubConnectionError(
          `This workspace is already connected to ${existing.repository}.`,
          "source_already_connected",
          409,
        );
      }
      await client.query(
        `UPDATE github_connections
            SET installation_id = $2, active = true, last_error = NULL
          WHERE id = $1`,
        [existing.id, input.installationId],
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
              jsonb_build_array(jsonb_build_object(
                'repo', $2::text,
                'installation_id', $3::bigint
              )),
              true
            ),
                updated_at = now()
          WHERE id = $1`,
        [code.collectionId, repository, input.installationId],
      );
      const id = `github_${generateUlid()}`;
      await client.query(
        `INSERT INTO github_connections
           (id, workspace_id, repository, installation_id, issues_collection_id,
            pull_requests_collection_id, code_collection_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          input.workspaceId,
          repository,
          input.installationId,
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

/** Make GitHub's required-check rule match this connection's Braino setting. */
export async function setGithubEnforcement(
  withClient: ClientScope,
  input: {
    connectionId: string;
    userId: string;
    required: boolean;
    plugin: GithubAppConnectorPlugin;
  },
): Promise<GithubConnectionSummary> {
  const connection = await withClient(async (client) => {
    const found = await client.query<ConnectionRow>(
      "SELECT * FROM github_connections WHERE id = $1",
      [input.connectionId],
    );
    const row = found.rows[0];
    if (!row || !row.active || row.installation_id === null) {
      throw new GithubConnectionError(
        "GitHub connection is not active.",
        "connection_inactive",
        409,
      );
    }
    await requireOwner(client, row.workspace_id, input.userId);
    return row as ConnectionRow & { installation_id: number | string };
  });
  await pluginCapability(input.plugin, "scm.ruleset.reconcile").reconcile({
    installationId: String(connection.installation_id),
    repository: connection.repository,
    checkName: "Braino",
    required: input.required,
  });
  return withClient(async (client) => {
    const changed = await client.query(
      `UPDATE github_connections
          SET require_braino = $2, last_error = NULL
        WHERE id = $1 AND active AND installation_id = $3
      RETURNING id`,
      [connection.id, input.required, connection.installation_id],
    );
    if (!changed.rows[0]) {
      throw new GithubConnectionError(
        "GitHub connection changed while enforcement was being configured.",
        "connection_changed",
        409,
      );
    }
    return summary(client, connection.id);
  });
}

const BRIEF_TRAILER = /(?:Doco|Braino)-Brief:\s*https?:\/\/\S+/i;
const RECORD_REFERENCE =
  /https?:\/\/[^\s)]+\/(?:decision|rule|intent|idea|eval|reference|log|action|state)\/(?:decision|rule|intent|idea|eval|reference|log|action|state)_[0-9A-Z]+/i;

export function pullRequestWentThroughBraino(input: {
  body: string | null;
  commitMessages: readonly string[];
}): boolean {
  return [input.body ?? "", ...input.commitMessages].some(
    (value) => BRIEF_TRAILER.test(value) || RECORD_REFERENCE.test(value),
  );
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export interface GithubWebhookDeliveryResult {
  event: string;
  synced: boolean;
  replayed: boolean;
  created: number;
  updated: number;
  unchanged: number;
}

/** Validate, deduplicate, sync, and check one delivery from the App-level webhook. */
export async function deliverGithubAppWebhook(
  withClient: ClientScope,
  input: {
    plugin: GithubAppConnectorPlugin;
    headers: Readonly<Record<string, string>>;
    body: string;
    fetcher?: Fetcher;
    codeGraphClient?: CodeGraphClient | null;
  },
): Promise<GithubWebhookDeliveryResult & { checked: boolean }> {
  const events = await pluginCapability(input.plugin, "event.receive").receive({
    body: new TextEncoder().encode(input.body),
    headers: input.headers,
  });
  const received = events[0];
  if (!received) {
    throw new GithubConnectionError("GitHub delivery contained no event.", "payload_invalid");
  }
  const payload = received.data;
  const installationId = Number(object(payload.installation)?.id);
  const repository = object(payload.repository)?.full_name;
  if (!Number.isInteger(installationId) || installationId <= 0 || typeof repository !== "string") {
    return {
      event: received.kind,
      synced: false,
      replayed: false,
      created: 0,
      updated: 0,
      unchanged: 0,
      checked: false,
    };
  }
  const connection = await withClient(async (client) => {
    const found = await client.query<ConnectionRow>(
      `SELECT * FROM github_connections
        WHERE installation_id = $1 AND lower(repository) = lower($2) AND active`,
      [installationId, repository],
    );
    const row = found.rows[0];
    if (!row) {
      throw new GithubConnectionError(
        "GitHub delivery is for a repository this workspace does not track.",
        "connection_not_found",
        404,
      );
    }
    const reserved = await client.query(
      `INSERT INTO github_webhook_deliveries (connection_id, delivery_id, event, status)
       VALUES ($1, $2, $3, 'processing')
       ON CONFLICT DO NOTHING
       RETURNING delivery_id`,
      [row.id, received.id.slice(0, 200), received.kind.slice(0, 100)],
    );
    if (reserved.rows[0]) return { row };
    const prior = await client.query<{
      status: string;
      response: (GithubWebhookDeliveryResult & { checked?: boolean }) | null;
    }>(
      `SELECT status, response FROM github_webhook_deliveries
        WHERE connection_id = $1 AND delivery_id = $2`,
      [row.id, received.id.slice(0, 200)],
    );
    if (prior.rows[0]?.status === "completed" && prior.rows[0].response) {
      return {
        replay: {
          ...prior.rows[0].response,
          replayed: true,
          checked: prior.rows[0].response.checked ?? false,
        },
      };
    }
    throw new GithubConnectionError(
      "This GitHub delivery is already processing.",
      "delivery_in_progress",
      409,
    );
  });
  if ("replay" in connection) return connection.replay;

  try {
    const supported =
      received.kind === "issues" || received.kind === "pull_request" || received.kind === "push";
    let checked = false;
    const pullRequest = object(payload.pull_request);
    const head = object(pullRequest?.head);
    const pullNumber = Number(pullRequest?.number);
    if (
      received.kind === "pull_request" &&
      pullRequest?.state === "open" &&
      Number.isInteger(pullNumber) &&
      pullNumber > 0 &&
      typeof head?.sha === "string"
    ) {
      const commitMessages = await input.plugin.github.pullRequestCommits({
        installationId,
        repository,
        pullNumber,
      });
      const passed = pullRequestWentThroughBraino({
        body: typeof pullRequest.body === "string" ? pullRequest.body : null,
        commitMessages,
      });
      const conclusion = passed ? "success" : connection.row.require_braino ? "failure" : "neutral";
      await pluginCapability(input.plugin, "scm.check.publish").publish({
        installationId: String(installationId),
        repository,
        name: "Braino",
        headSha: head.sha,
        conclusion,
        title: passed
          ? "Went through Braino"
          : connection.row.require_braino
            ? "Didn't go through Braino"
            : "No Braino evidence",
        summary: passed
          ? "A pull-request commit or description cites the Braino brief or record used for this work."
          : connection.row.require_braino
            ? "This repository requires Braino, but no commit trailer or Braino record was found. Read the Braino brief and end the next commit with its Doco-Brief line."
            : "No commit trailer or Braino record was found; enforcement is not enabled for this repository.",
      });
      checked = true;
    }
    const synced = supported
      ? await syncGithubConnection(withClient, {
          connectionId: connection.row.id,
          plugin: input.plugin,
          ...(input.fetcher ? { fetcher: input.fetcher } : {}),
          ...(input.codeGraphClient !== undefined
            ? { codeGraphClient: input.codeGraphClient }
            : {}),
        })
      : { created: 0, updated: 0, unchanged: 0 };
    const result = {
      event: received.kind,
      synced: supported,
      replayed: false,
      ...synced,
      checked,
    };
    await withClient(async (client) => {
      await client.query(
        `UPDATE github_webhook_deliveries
            SET status = 'completed', response = $3::jsonb, completed_at = now()
          WHERE connection_id = $1 AND delivery_id = $2`,
        [connection.row.id, received.id.slice(0, 200), JSON.stringify(result)],
      );
      await client.query(
        "UPDATE github_connections SET webhook_last_delivery_at = now() WHERE id = $1",
        [connection.row.id],
      );
    });
    return result;
  } catch (error) {
    await withClient((client) =>
      client.query(
        `DELETE FROM github_webhook_deliveries
          WHERE connection_id = $1 AND delivery_id = $2 AND status = 'processing'`,
        [connection.row.id, received.id.slice(0, 200)],
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
  },
): Promise<void> {
  const claimed = await claimGithubOperation(withClient, {
    connectionId: input.connectionId,
    userId: input.userId,
  });
  try {
    await withClient(async (client) => {
      const disconnected = await client.query(
        `UPDATE github_connections
            SET active = false, installation_id = NULL, last_error = NULL,
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

async function fetchPages(
  fetcher: Fetcher,
  url: string,
  accessToken: string,
): Promise<GithubItem[]> {
  const items: GithubItem[] = [];
  let bytes = 0;
  let next: string | null = url;
  for (let page = 0; next && page < 100; page += 1) {
    const pageResult = await githubJson(fetcher, next, accessToken);
    const { value, response } = pageResult;
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
    next = nextLink(response.headers.get("link"));
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
  fetcher: Fetcher,
  repository: string,
  accessToken: string,
  stored: Map<string, string>,
): Promise<CodeSnapshot> {
  const defaultBranch = await verifyRepository(fetcher, repository, accessToken);
  const { value } = await githubJson(
    fetcher,
    `${API}/repos/${repository}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    accessToken,
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
          const blob = await githubJson(
            fetcher,
            `${API}/repos/${repository}/git/blobs/${file.sha}`,
            accessToken,
          );
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
    plugin: GithubAppConnectorPlugin;
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
    const accessToken = await input.plugin.github.mintInstallationToken(
      claimed.connection.installation_id,
    );
    const fetcher = input.fetcher ?? fetch;
    const stored = await storedCodeShas(
      withClient,
      claimed.connection.code_collection_id,
      claimed.connection.repository,
    );
    const [issues, pulls, codeSnapshot] = await Promise.all([
      fetchPages(
        fetcher,
        `${API}/repos/${claimed.connection.repository}/issues?state=all&per_page=100`,
        accessToken,
      ),
      fetchPages(
        fetcher,
        `${API}/repos/${claimed.connection.repository}/pulls?state=all&per_page=100`,
        accessToken,
      ),
      fetchCodeSnapshot(fetcher, claimed.connection.repository, accessToken, stored),
    ]);
    const result = await withClient(async (client) => {
      await client.query("BEGIN");
      try {
        const locked = await client.query<ConnectionRow>(
          "SELECT * FROM github_connections WHERE id = $1 FOR UPDATE",
          [claimed.connection.id],
        );
        const current = locked.rows[0];
        if (!current || !current.active || current.installation_id === null) {
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
