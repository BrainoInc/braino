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
  const provider = providers[0];
  const configured = configuration(provider?.configuration);
  if (!provider || !configured || !valid(configured)) return "invalid";
  const manifest = parsePluginManifest(provider.manifest);
  const required = Array.isArray(manifest.secretSchema?.required)
    ? manifest.secretSchema.required.filter((name): name is string => typeof name === "string")
    : [];
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
