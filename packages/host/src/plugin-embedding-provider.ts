import type { PoolClient } from "@braino/db";
import type { EmbeddingInputType, EmbeddingProvider } from "@braino/index";
import type { EmbeddingResponse } from "@braino/plugin-runtime";
import { resolveActiveWorkspaceModelPlugin } from "./model-plugin-installation.js";
import {
  type PluginHostConnection,
  PluginInvocationError,
  invokePlugin,
} from "./plugin-invocation.js";

type Fetcher = typeof fetch;

function positiveInteger(value: number | null, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new PluginInvocationError(`${label} is invalid.`, "verification_invalid");
  }
  return Number(value);
}

export class PluginEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;

  constructor(
    private readonly client: PoolClient,
    private readonly installation: {
      workspaceId: string;
      installationId: string;
      pluginId: string;
      model: string;
      dimensions: number;
    },
    private readonly connection: {
      encryptionKey: string;
      host: PluginHostConnection;
      fetcher?: Fetcher;
    },
  ) {
    this.modelId = `plugin:${installation.pluginId}:${installation.model}`;
    this.dimensions = installation.dimensions;
  }

  async embed(
    texts: string[],
    inputType?: EmbeddingInputType,
    _signal?: AbortSignal,
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const output = await invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability: "embedding.embed",
      input: {
        inputs: texts,
        ...(inputType ? { inputType } : {}),
      },
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    });
    const embedding = output as EmbeddingResponse;
    if (embedding.dimensions !== this.dimensions) {
      throw new PluginInvocationError(
        "Plugin returned unexpected embedding dimensions.",
        "plugin_output_invalid",
        502,
      );
    }
    return embedding.vectors.map((vector) => new Float32Array(vector));
  }
}

export async function resolveWorkspaceEmbeddingProvider(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginEmbeddingProvider | null> {
  const installation = await resolveActiveWorkspaceModelPlugin(
    client,
    input.workspaceId,
    "embedding.embed",
  );
  if (!installation) return null;
  return new PluginEmbeddingProvider(
    client,
    {
      ...installation,
      dimensions: positiveInteger(
        installation.verifiedEmbeddingDimensions,
        "Verified embedding plugin dimensions",
      ),
    },
    {
      encryptionKey: input.encryptionKey,
      host: input.host,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    },
  );
}
