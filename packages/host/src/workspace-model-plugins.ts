import type { PoolClient } from "@doco/db";
import {
  type ChatCompleteResponse,
  type EmbeddingResponse,
  type PluginCapabilityName,
  parsePluginManifest,
  pluginProvidesCapability,
} from "@doco/plugin-runtime";
import { resolveAssignedModelPlugin } from "./model-plugin-installation.js";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
} from "./plugin-installations.js";
import {
  type PluginHostConnection,
  PluginInvocationError,
  invokePlugin,
} from "./plugin-invocation.js";

/** The two models every workspace needs, named by the capability that provides each. */
export const MODEL_CAPABILITIES = [
  "chat.complete",
  "embedding.embed",
] as const satisfies readonly PluginCapabilityName[];

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export type ModelPluginStatus = "missing" | "invalid" | "ambiguous" | "unverified" | "ready";

export interface WorkspaceModelPluginReadiness {
  ready: boolean;
  chat: ModelPluginStatus;
  embedding: ModelPluginStatus;
}

interface InstallationRow {
  manifest: unknown;
  configuration: unknown;
  secret_names: string[];
  verified_at: Date | string | null;
  verified_embedding_dimensions: number | null;
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

function usableConfiguration(configured: Readonly<Record<string, string>>): boolean {
  return Boolean(configured.model?.trim());
}

function status(rows: readonly InstallationRow[], capability: ModelCapability): ModelPluginStatus {
  const providers = rows.filter((row) =>
    pluginProvidesCapability(parsePluginManifest(row.manifest), capability),
  );
  if (providers.length === 0) return "missing";
  if (providers.length > 1) return "ambiguous";
  const provider = providers[0];
  const configured = configuration(provider?.configuration);
  if (!provider || !configured || !usableConfiguration(configured)) return "invalid";
  const required = requiredSecretNames(parsePluginManifest(provider.manifest).secretSchema);
  if (!required.every((name) => provider.secret_names.includes(name))) return "invalid";
  if (!provider.verified_at) return "unverified";
  if (
    capability === "embedding.embed" &&
    (!Number.isInteger(provider.verified_embedding_dimensions) ||
      Number(provider.verified_embedding_dimensions) < 1)
  ) {
    return "invalid";
  }
  return "ready";
}

export async function getWorkspaceModelPluginReadiness(
  client: PoolClient,
  workspaceId: string,
): Promise<WorkspaceModelPluginReadiness> {
  const found = await client.query<InstallationRow>(
    `SELECT i.manifest, i.configuration, i.verified_at,
            i.verified_embedding_dimensions,
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

/**
 * Exercises the two assigned model capabilities before the workspace opens.
 * Neither installation is marked verified unless both calls succeed. The
 * embedding width comes from the model response, never from a user-entered
 * number, and becomes the width enforced by later indexing calls.
 */
export async function verifyWorkspaceModelPlugins(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: typeof fetch;
  },
): Promise<{
  chatModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
}> {
  const [chat, embedding] = await Promise.all([
    resolveAssignedModelPlugin(client, input.workspaceId, "chat.complete", {
      requireVerified: false,
    }),
    resolveAssignedModelPlugin(client, input.workspaceId, "embedding.embed", {
      requireVerified: false,
    }),
  ]);
  if (!chat) {
    throw new ModelPluginVerificationError(
      "chat",
      new PluginInvocationError("Chat model plugin is missing.", "chat_plugin_missing", 400),
    );
  }
  if (!embedding) {
    throw new ModelPluginVerificationError(
      "embedding",
      new PluginInvocationError(
        "Embedding model plugin is missing.",
        "embedding_plugin_missing",
        400,
      ),
    );
  }

  const connection = {
    encryptionKey: input.encryptionKey,
    host: input.host,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  };
  const verify = async <T>(kind: "chat" | "embedding", call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      throw new ModelPluginVerificationError(kind, error);
    }
  };
  const [chatOutput, embeddingOutput] = await Promise.all([
    verify(
      "chat",
      () =>
        invokePlugin(client, {
          workspaceId: input.workspaceId,
          installationId: chat.installationId,
          capability: "chat.complete",
          input: { messages: [{ role: "user", content: "Reply with OK." }] },
          ...connection,
        }) as Promise<ChatCompleteResponse>,
    ),
    verify(
      "embedding",
      () =>
        invokePlugin(client, {
          workspaceId: input.workspaceId,
          installationId: embedding.installationId,
          capability: "embedding.embed",
          input: { inputs: ["Braino model setup verification"], inputType: "query" },
          ...connection,
        }) as Promise<EmbeddingResponse>,
    ),
  ]);

  await client.query("BEGIN");
  try {
    const chatUpdate = await client.query<{ id: string }>(
      `UPDATE plugin_installations
          SET verified_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND updated_at = $3::timestamptz
        RETURNING id`,
      [input.workspaceId, chat.installationId, chat.updatedAt],
    );
    const embeddingUpdate = await client.query<{ id: string }>(
      `UPDATE plugin_installations
          SET verified_at = now(),
              verified_embedding_dimensions = $4,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND updated_at = $3::timestamptz
        RETURNING id`,
      [
        input.workspaceId,
        embedding.installationId,
        embedding.updatedAt,
        embeddingOutput.dimensions,
      ],
    );
    if (chatUpdate.rows.length !== 1 || embeddingUpdate.rows.length !== 1) {
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

  return {
    chatModel: chatOutput.model,
    embeddingModel: embeddingOutput.model,
    embeddingDimensions: embeddingOutput.dimensions,
  };
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
