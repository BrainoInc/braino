import type { PoolClient } from "@doco/db";
import { type PluginCapabilityName, parsePluginManifest } from "@doco/plugin-runtime";
import { installPlugin } from "./plugin-installations.js";

export type ModelPluginStatus = "missing" | "invalid" | "ambiguous" | "ready";

export interface WorkspaceModelPluginReadiness {
  ready: boolean;
  chat: ModelPluginStatus;
  embedding: ModelPluginStatus;
}

interface InstallationRow {
  manifest: unknown;
  configuration: unknown;
}

export interface ModelPluginBundle {
  manifest: unknown;
  component: Uint8Array;
  configuration: Readonly<Record<string, string>>;
}

function configuration(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, item]) => typeof item === "string")
    ? (value as Record<string, string>)
    : null;
}

function status(
  rows: readonly InstallationRow[],
  capability: PluginCapabilityName,
  valid: (configuration: Readonly<Record<string, string>>) => boolean,
): ModelPluginStatus {
  const providers = rows.filter((row) =>
    parsePluginManifest(row.manifest).capabilities.includes(capability),
  );
  if (providers.length === 0) return "missing";
  if (providers.length > 1) return "ambiguous";
  const configured = configuration(providers[0]?.configuration);
  return configured && valid(configured) ? "ready" : "invalid";
}

export async function getWorkspaceModelPluginReadiness(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceModelPluginReadiness> {
  const found = await client.query<InstallationRow>(
    `SELECT manifest, configuration
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND (manifest->'capabilities' ? 'chat.complete'
          OR manifest->'capabilities' ? 'embedding.embed')
      ORDER BY id`,
    [workspaceId],
  );
  const chat = status(found.rows, "chat.complete", (configured) =>
    Boolean(configured.model?.trim()),
  );
  const embedding = status(found.rows, "embedding.embed", (configured) => {
    const dimensions = Number(configured.dimensions);
    return Boolean(configured.model?.trim()) && Number.isInteger(dimensions) && dimensions > 0;
  });
  return { ready: chat === "ready" && embedding === "ready", chat, embedding };
}

function requireCapability(bundle: ModelPluginBundle, capability: PluginCapabilityName): void {
  const manifest = parsePluginManifest(bundle.manifest);
  if (!manifest.capabilities.includes(capability)) {
    throw new Error(`${manifest.name} does not provide ${capability}.`);
  }
}

export async function installRequiredModelPlugins(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    chat: ModelPluginBundle;
    embedding: ModelPluginBundle;
  },
): Promise<WorkspaceModelPluginReadiness> {
  requireCapability(input.chat, "chat.complete");
  requireCapability(input.embedding, "embedding.embed");
  await installPlugin(client, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...input.chat,
  });
  await installPlugin(client, {
    workspaceId: input.workspaceId,
    userId: input.userId,
    ...input.embedding,
  });
  const readiness = await getWorkspaceModelPluginReadiness(client, input.workspaceId);
  if (!readiness.ready) {
    throw new Error("Exactly one chat plugin and one embedding plugin must be configured.");
  }
  return readiness;
}
