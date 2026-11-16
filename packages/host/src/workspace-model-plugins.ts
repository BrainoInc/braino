import type { PoolClient } from "@doco/db";
import {
  type PluginCapabilityName,
  parsePluginManifest,
  pluginProvidesCapability,
} from "@doco/plugin-runtime";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
} from "./plugin-installations.js";

/** The two models every workspace needs, named by the capability that provides each. */
export const MODEL_CAPABILITIES = [
  "chat.complete",
  "embedding.embed",
] as const satisfies readonly PluginCapabilityName[];

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export type ModelPluginStatus = "missing" | "invalid" | "ambiguous" | "ready";

export interface WorkspaceModelPluginReadiness {
  ready: boolean;
  chat: ModelPluginStatus;
  embedding: ModelPluginStatus;
}

interface InstallationRow {
  manifest: unknown;
  configuration: unknown;
  secret_names: string[];
}

export interface ModelPluginBundle {
  manifest: unknown;
  component: Uint8Array;
  configuration: Readonly<Record<string, string>>;
  secrets?: Readonly<Record<string, string>>;
  encryptionKey?: string;
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

function usableConfiguration(
  capability: ModelCapability,
  configured: Readonly<Record<string, string>>,
): boolean {
  if (!configured.model?.trim()) return false;
  if (capability === "chat.complete") return true;
  const dimensions = Number(configured.dimensions);
  return Number.isInteger(dimensions) && dimensions > 0;
}

function status(rows: readonly InstallationRow[], capability: ModelCapability): ModelPluginStatus {
  const providers = rows.filter((row) =>
    pluginProvidesCapability(parsePluginManifest(row.manifest), capability),
  );
  if (providers.length === 0) return "missing";
  if (providers.length > 1) return "ambiguous";
  const provider = providers[0];
  const configured = configuration(provider?.configuration);
  if (!provider || !configured || !usableConfiguration(capability, configured)) return "invalid";
  const required = requiredSecretNames(parsePluginManifest(provider.manifest).secretSchema);
  return required.every((name) => provider.secret_names.includes(name)) ? "ready" : "invalid";
}

export async function getWorkspaceModelPluginReadiness(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceModelPluginReadiness> {
  const found = await client.query<InstallationRow>(
    `SELECT i.manifest, i.configuration,
            ARRAY(
              SELECT s.name
                FROM plugin_installation_secrets s
               WHERE s.installation_id = i.id
               ORDER BY s.name
            ) AS secret_names
       FROM plugin_installations i
      WHERE workspace_id = $1 AND enabled
        AND (manifest->'capabilities' ? 'chat.complete'
          OR manifest->'capabilities' ? 'embedding.embed')
      ORDER BY id`,
    [workspaceId],
  );
  const chat = status(found.rows, "chat.complete");
  const embedding = status(found.rows, "embedding.embed");
  return { ready: chat === "ready" && embedding === "ready", chat, embedding };
}

/**
 * Makes one plugin the workspace's provider for one model. The plugin is
 * installed or updated with its own configuration and its own secrets, and
 * every other enabled plugin with the same capability is disabled, all in one
 * transaction. An enabled plugin is an assigned one, so the plugin must
 * provide only this model: enabling it must not also assign it to the other.
 * Secrets the plugin already holds are kept unless new ones are given.
 */
export async function assignWorkspaceModelPlugin(
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
      `${manifest.name} cannot be assigned as the only provider of ${input.capability}.`,
      "capability_not_provided",
    );
  }
  if (!usableConfiguration(input.capability, input.plugin.configuration)) {
    throw new PluginInstallationError(
      input.capability === "chat.complete"
        ? "A chat plugin requires a model."
        : "An embedding plugin requires a model and positive integer dimensions.",
      "configuration_invalid",
    );
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
    await client.query(
      `UPDATE plugin_installations
          SET enabled = false, updated_by_user_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND id <> $2 AND enabled
          AND manifest->'capabilities' ? $4`,
      [input.workspaceId, installed.id, input.userId, input.capability],
    );
    await client.query("COMMIT");
    return installed;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
