import type { PoolClient } from "@braino/db";
import { type ModelCapabilityName, parsePluginManifest } from "@braino/plugin-runtime";
import { PluginInvocationError } from "./plugin-invocation.js";

interface InstallationRow {
  id: string;
  manifest: unknown;
  configuration: unknown;
  updated_at: string;
  verified_embedding_dimensions: number | null;
}

export interface WorkspaceModelPluginInstallation {
  workspaceId: string;
  installationId: string;
  pluginId: string;
  model: string;
  configuration: Readonly<Record<string, string>>;
  updatedAt: string;
  verifiedEmbeddingDimensions: number | null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInvocationError(
      "Model plugin configuration is invalid.",
      "configuration_invalid",
    );
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new PluginInvocationError(
      "Model plugin configuration is invalid.",
      "configuration_invalid",
    );
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function mappedInstallation(
  row: InstallationRow,
  workspaceId: string,
): WorkspaceModelPluginInstallation {
  const manifest = parsePluginManifest(row.manifest);
  const configuration = stringRecord(row.configuration);
  const model = configuration.model?.trim();
  if (!model) {
    throw new PluginInvocationError("Model plugin model is invalid.", "configuration_invalid");
  }
  return {
    workspaceId,
    installationId: row.id,
    pluginId: manifest.id,
    model,
    configuration,
    updatedAt: row.updated_at,
    verifiedEmbeddingDimensions: row.verified_embedding_dimensions,
  };
}

/** Resolves one installed provider without changing or requiring the active selection. */
export async function resolveWorkspaceModelPluginInstallation(
  client: PoolClient,
  input: { workspaceId: string; installationId: string; capability: ModelCapabilityName },
  options: { requireVerified?: boolean } = {},
): Promise<WorkspaceModelPluginInstallation | null> {
  const requireVerified = options.requireVerified !== false;
  const found = await client.query<InstallationRow>(
    `SELECT id, manifest, configuration, updated_at::text AS updated_at,
            verified_embedding_dimensions
       FROM plugin_installations
      WHERE workspace_id = $1 AND id = $2 AND enabled
        AND manifest->'capabilities' ? $3
        AND (NOT $4::boolean OR verified_at IS NOT NULL)`,
    [input.workspaceId, input.installationId, input.capability, requireVerified],
  );
  const row = found.rows[0];
  return row ? mappedInstallation(row, input.workspaceId) : null;
}

/** Resolves the workspace's explicitly selected provider for one model capability. */
export async function resolveActiveWorkspaceModelPlugin(
  client: PoolClient,
  workspaceId: string,
  capability: ModelCapabilityName,
  options: { requireVerified?: boolean } = {},
): Promise<WorkspaceModelPluginInstallation | null> {
  const requireVerified = options.requireVerified !== false;
  const found = await client.query<InstallationRow>(
    `SELECT i.id, i.manifest, i.configuration, i.updated_at::text AS updated_at,
            i.verified_embedding_dimensions
       FROM workspace_model_plugin_selections selected
       JOIN plugin_installations i
         ON i.workspace_id = selected.workspace_id
        AND i.id = selected.installation_id
      WHERE selected.workspace_id = $1 AND selected.capability = $2
        AND i.enabled
        AND (NOT $3::boolean OR i.verified_at IS NOT NULL)`,
    [workspaceId, capability, requireVerified],
  );
  const row = found.rows[0];
  return row ? mappedInstallation(row, workspaceId) : null;
}
