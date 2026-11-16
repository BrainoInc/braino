import type { PoolClient } from "@doco/db";
import { type ModelCapabilityName, parsePluginManifest } from "@doco/plugin-runtime";
import { PluginInvocationError } from "./plugin-invocation.js";

interface InstallationRow {
  id: string;
  manifest: unknown;
  configuration: unknown;
}

export interface AssignedModelPlugin {
  workspaceId: string;
  installationId: string;
  pluginId: string;
  model: string;
  configuration: Readonly<Record<string, string>>;
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

/** Resolves the workspace's one enabled provider for a model capability. */
export async function resolveAssignedModelPlugin(
  client: PoolClient,
  workspaceId: string,
  capability: ModelCapabilityName,
): Promise<AssignedModelPlugin | null> {
  const found = await client.query<InstallationRow>(
    `SELECT id, manifest, configuration
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND manifest->'capabilities' ? $2
      ORDER BY updated_at DESC, id
      LIMIT 2`,
    [workspaceId, capability],
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1) {
    throw new PluginInvocationError(
      `Only one ${capability} plugin can be enabled per workspace.`,
      capability === "chat.complete" ? "chat_plugin_ambiguous" : "embedding_plugin_ambiguous",
      409,
    );
  }
  const row = found.rows[0];
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
  };
}
