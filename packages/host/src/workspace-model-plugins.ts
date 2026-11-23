import type { PoolClient } from "@doco/db";
import {
  type ChatCompleteResponse,
  type EmbeddingResponse,
  type PluginCapabilityName,
  parsePluginManifest,
  pluginProvidesCapability,
} from "@doco/plugin-runtime";
import {
  resolveActiveWorkspaceModelPlugin,
  resolveWorkspaceModelPluginInstallation,
} from "./model-plugin-installation.js";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
  requireWorkspacePluginOwner,
} from "./plugin-installations.js";
import {
  type PluginHostConnection,
  PluginInvocationError,
  invokePlugin,
} from "./plugin-invocation.js";

/** The two independently selectable models every workspace needs. */
export const MODEL_CAPABILITIES = [
  "chat.complete",
  "embedding.embed",
] as const satisfies readonly PluginCapabilityName[];

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];
export type ModelPluginStatus = "missing" | "invalid" | "unverified" | "ready";

export interface WorkspaceModelPluginReadiness {
  ready: boolean;
  chat: ModelPluginStatus;
  embedding: ModelPluginStatus;
}

export interface ModelPluginBundle {
  manifest: unknown;
  component: Uint8Array;
  configuration: Readonly<Record<string, string>>;
  secrets?: Readonly<Record<string, string>>;
  encryptionKey?: string;
}

export interface WorkspaceModelPlugin {
  workspaceId: string;
  installationId: string;
  pluginId: string;
  name: string;
  capability: ModelCapability;
  model: string;
  configuration: Readonly<Record<string, string>>;
  secretNames: readonly string[];
  active: boolean;
  verified: boolean;
  verifiedEmbeddingDimensions: number | null;
  updatedAt: string;
}

interface InstallationRow {
  workspace_id: string;
  id: string;
  manifest: unknown;
  configuration: unknown;
  secret_names: string[];
  active_capability: string | null;
  verified_at: Date | string | null;
  verified_embedding_dimensions: number | null;
  updated_at: Date | string;
}

interface SelectedInstallationRow {
  manifest: unknown;
  configuration: unknown;
  secret_names: string[];
  verified_at: Date | string | null;
  verified_embedding_dimensions: number | null;
}

function configuration(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? (value as Record<string, string>)
    : null;
}

function requiredSecretNames(schema: Readonly<Record<string, unknown>> | undefined): string[] {
  return Array.isArray(schema?.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : [];
}

function usableConfiguration(configured: Readonly<Record<string, string>>): boolean {
  return Boolean(configured.model?.trim());
}

function modelCapability(manifest: unknown): ModelCapability | null {
  const parsed = parsePluginManifest(manifest);
  const provided = MODEL_CAPABILITIES.filter((capability) =>
    pluginProvidesCapability(parsed, capability),
  );
  return provided.length === 1 ? provided[0] : null;
}

function status(
  row: SelectedInstallationRow | undefined,
  capability: ModelCapability,
): ModelPluginStatus {
  if (!row) return "missing";
  const manifest = parsePluginManifest(row.manifest);
  if (!pluginProvidesCapability(manifest, capability)) return "invalid";
  const configured = configuration(row.configuration);
  if (!configured || !usableConfiguration(configured)) return "invalid";
  const required = requiredSecretNames(manifest.secretSchema);
  if (!required.every((name) => row.secret_names.includes(name))) return "invalid";
  if (!row.verified_at) return "unverified";
  if (
    capability === "embedding.embed" &&
    (!Number.isInteger(row.verified_embedding_dimensions) ||
      Number(row.verified_embedding_dimensions) < 1)
  ) {
    return "invalid";
  }
  return "ready";
}

/** Lists every installed model plugin and identifies the active one per capability. */
export async function listWorkspaceModelPlugins(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceModelPlugin[]> {
  const found = await client.query<InstallationRow>(
    `SELECT i.workspace_id, i.id, i.manifest, i.configuration,
            i.verified_at, i.verified_embedding_dimensions, i.updated_at,
            selected.capability AS active_capability,
            ARRAY(
              SELECT secret.name
                FROM plugin_installation_secrets secret
               WHERE secret.installation_id = i.id
               ORDER BY secret.name
            ) AS secret_names
       FROM plugin_installations i
       LEFT JOIN workspace_model_plugin_selections selected
         ON selected.workspace_id = i.workspace_id
        AND selected.installation_id = i.id
      WHERE i.workspace_id = $1 AND i.enabled
        AND (i.manifest->'capabilities' ? 'chat.complete'
          OR i.manifest->'capabilities' ? 'embedding.embed')
      ORDER BY i.created_at, i.id`,
    [workspaceId],
  );
  return found.rows.map((row) => {
    const manifest = parsePluginManifest(row.manifest);
    const capability = modelCapability(row.manifest);
    const configured = configuration(row.configuration);
    const model = configured?.model?.trim();
    if (!capability || !configured || !model) {
      throw new PluginInstallationError(
        "Stored model plugin configuration is invalid.",
        "configuration_invalid",
        500,
      );
    }
    return {
      workspaceId: row.workspace_id,
      installationId: row.id,
      pluginId: manifest.id,
      name: manifest.name,
      capability,
      model,
      configuration: configured,
      secretNames: row.secret_names,
      active: row.active_capability === capability,
      verified: Boolean(row.verified_at),
      verifiedEmbeddingDimensions: row.verified_embedding_dimensions,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}

export async function getWorkspaceModelPluginReadiness(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceModelPluginReadiness> {
  const found = await client.query<SelectedInstallationRow & { capability: ModelCapability }>(
    `SELECT selected.capability, i.manifest, i.configuration, i.verified_at,
            i.verified_embedding_dimensions,
            ARRAY(
              SELECT secret.name
                FROM plugin_installation_secrets secret
               WHERE secret.installation_id = i.id
               ORDER BY secret.name
            ) AS secret_names
       FROM workspace_model_plugin_selections selected
       JOIN plugin_installations i
         ON i.workspace_id = selected.workspace_id
        AND i.id = selected.installation_id
      WHERE selected.workspace_id = $1 AND i.enabled`,
    [workspaceId],
  );
  const selected = new Map(found.rows.map((row) => [row.capability, row]));
  const chat = status(selected.get("chat.complete"), "chat.complete");
  const embedding = status(selected.get("embedding.embed"), "embedding.embed");
  return { ready: chat === "ready" && embedding === "ready", chat, embedding };
}

export class ModelPluginVerificationError extends PluginInvocationError {
  constructor(
    public readonly kind: "chat" | "embedding",
    error: unknown,
  ) {
    const invocation = error instanceof PluginInvocationError ? error : null;
    super(
      `${kind === "chat" ? "Chat" : "Embedding"} model verification failed.`,
      invocation?.code ?? "verification_failed",
      invocation?.status ?? 502,
    );
    this.name = "ModelPluginVerificationError";
    this.cause = error;
  }
}

/** Exercises one specific installed model plugin before it may become active. */
export async function verifyWorkspaceModelPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    capability: ModelCapability;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: typeof fetch;
  },
): Promise<{ model: string; dimensions?: number }> {
  const kind = input.capability === "chat.complete" ? "chat" : "embedding";
  const plugin = await resolveWorkspaceModelPluginInstallation(
    client,
    {
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      capability: input.capability,
    },
    { requireVerified: false },
  );
  if (!plugin) {
    throw new ModelPluginVerificationError(
      kind,
      new PluginInvocationError(
        `${kind === "chat" ? "Chat" : "Embedding"} model plugin is missing.`,
        `${kind}_plugin_missing`,
        400,
      ),
    );
  }

  const connection = {
    encryptionKey: input.encryptionKey,
    host: input.host,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  };
  let output: ChatCompleteResponse | EmbeddingResponse;
  try {
    output =
      input.capability === "chat.complete"
        ? await (invokePlugin(client, {
            workspaceId: input.workspaceId,
            installationId: plugin.installationId,
            capability: input.capability,
            input: { messages: [{ role: "user", content: "Reply with OK." }] },
            ...connection,
          }) as Promise<ChatCompleteResponse>)
        : await (invokePlugin(client, {
            workspaceId: input.workspaceId,
            installationId: plugin.installationId,
            capability: input.capability,
            input: { inputs: ["Braino model setup verification"], inputType: "query" },
            ...connection,
          }) as Promise<EmbeddingResponse>);
  } catch (error) {
    throw new ModelPluginVerificationError(kind, error);
  }

  await client.query("BEGIN");
  try {
    const update = await client.query<{ id: string }>(
      `UPDATE plugin_installations
          SET verified_at = now(),
              verified_embedding_dimensions = $4,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND updated_at = $3::timestamptz
        RETURNING id`,
      [
        input.workspaceId,
        plugin.installationId,
        plugin.updatedAt,
        input.capability === "embedding.embed" ? (output as EmbeddingResponse).dimensions : null,
      ],
    );
    if (update.rows.length !== 1) {
      throw new PluginInvocationError(
        "Model plugin configuration changed during verification.",
        "configuration_changed",
        409,
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  return input.capability === "embedding.embed"
    ? { model: output.model, dimensions: (output as EmbeddingResponse).dimensions }
    : { model: output.model };
}

/** Installs or updates a model plugin without changing the workspace's active provider. */
export async function installWorkspaceModelPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    capability: ModelCapability;
    plugin: ModelPluginBundle;
  },
): Promise<PluginInstallation> {
  const manifest = parsePluginManifest(input.plugin.manifest);
  const provided = MODEL_CAPABILITIES.filter((capability) =>
    pluginProvidesCapability(manifest, capability),
  );
  if (provided.length !== 1 || provided[0] !== input.capability) {
    throw new PluginInstallationError(
      `${manifest.name} cannot be installed as a provider of ${input.capability}.`,
      "capability_not_provided",
    );
  }
  if (!usableConfiguration(input.plugin.configuration)) {
    throw new PluginInstallationError("A model plugin requires a model.", "configuration_invalid");
  }
  await client.query("BEGIN");
  try {
    const installed = await installPluginInTransaction(client, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      ...input.plugin,
    });
    const stored = await client.query<{ name: string }>(
      "SELECT name FROM plugin_installation_secrets WHERE installation_id = $1",
      [installed.id],
    );
    const held = new Set(stored.rows.map((row) => row.name));
    const missing = requiredSecretNames(manifest.secretSchema).find((name) => !held.has(name));
    if (missing) {
      throw new PluginInstallationError(
        `${manifest.name} requires its own ${missing} secret.`,
        "secret_required",
      );
    }
    await client.query("COMMIT");
    return installed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export interface WorkspaceModelPluginSelection {
  workspaceId: string;
  capability: ModelCapability;
  installationId: string;
  pluginId: string;
  updatedAt: string;
}

/** Atomically makes one verified installation active for one model capability. */
export async function activateWorkspaceModelPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    capability: ModelCapability;
    installationId: string;
  },
): Promise<WorkspaceModelPluginSelection> {
  await client.query("BEGIN");
  try {
    await requireWorkspacePluginOwner(client, input.workspaceId, input.userId);
    const found = await client.query<{
      manifest: unknown;
      verified_at: Date | string | null;
      verified_embedding_dimensions: number | null;
    }>(
      `SELECT manifest, verified_at, verified_embedding_dimensions
         FROM plugin_installations
        WHERE workspace_id = $1 AND id = $2 AND enabled
        FOR UPDATE`,
      [input.workspaceId, input.installationId],
    );
    const row = found.rows[0];
    if (!row) {
      throw new PluginInstallationError(
        "Plugin installation is unavailable.",
        "installation_unavailable",
        404,
      );
    }
    const manifest = parsePluginManifest(row.manifest);
    if (!pluginProvidesCapability(manifest, input.capability)) {
      throw new PluginInstallationError(
        `${manifest.name} does not provide ${input.capability}.`,
        "capability_not_provided",
      );
    }
    if (
      !row.verified_at ||
      (input.capability === "embedding.embed" &&
        (!Number.isInteger(row.verified_embedding_dimensions) ||
          Number(row.verified_embedding_dimensions) < 1))
    ) {
      throw new PluginInstallationError(
        "Verify the plugin before making it active.",
        "plugin_unverified",
      );
    }
    const selected = await client.query<{ updated_at: Date | string }>(
      `INSERT INTO workspace_model_plugin_selections
         (workspace_id, capability, installation_id, updated_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, capability) DO UPDATE
         SET installation_id = EXCLUDED.installation_id,
             updated_by_user_id = EXCLUDED.updated_by_user_id,
             updated_at = now()
       RETURNING updated_at`,
      [input.workspaceId, input.capability, input.installationId, input.userId],
    );
    const selection = selected.rows[0];
    if (!selection) {
      throw new PluginInstallationError("Plugin activation failed.", "activation_failed", 500);
    }
    await client.query("COMMIT");
    return {
      workspaceId: input.workspaceId,
      capability: input.capability,
      installationId: input.installationId,
      pluginId: manifest.id,
      updatedAt: new Date(selection.updated_at).toISOString(),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Returns the selected installation for consumers that need its public configuration. */
export async function getActiveWorkspaceModelPlugin(
  client: PoolClient,
  workspaceId: string,
  capability: ModelCapability,
) {
  return resolveActiveWorkspaceModelPlugin(client, workspaceId, capability);
}
