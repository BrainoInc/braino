import type { PoolClient } from "@doco/db";
import type {
  ChatCompleteCapability,
  ChatCompleteRequest,
  ChatCompleteResponse,
} from "@doco/plugin-runtime";
import { resolveActiveWorkspaceModelPlugin } from "./model-plugin-installation.js";
import { type PluginHostConnection, invokePlugin } from "./plugin-invocation.js";

type Fetcher = typeof fetch;

/** The only chat-model interface Braino needs, backed by the assigned plugin. */
export class PluginChatProvider implements ChatCompleteCapability {
  readonly modelId: string;

  constructor(
    private readonly client: PoolClient,
    private readonly installation: {
      workspaceId: string;
      installationId: string;
      pluginId: string;
      model: string;
    },
    private readonly connection: {
      encryptionKey: string;
      host: PluginHostConnection;
      fetcher?: Fetcher;
    },
  ) {
    this.modelId = `plugin:${installation.pluginId}:${installation.model}`;
  }

  async complete(input: ChatCompleteRequest): Promise<ChatCompleteResponse> {
    const output = await invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability: "chat.complete",
      input,
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    });
    return output as ChatCompleteResponse;
  }
}

export async function resolveWorkspaceChatProvider(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginChatProvider | null> {
  const installation = await resolveActiveWorkspaceModelPlugin(
    client,
    input.workspaceId,
    "chat.complete",
  );
  if (!installation) return null;
  return new PluginChatProvider(client, installation, {
    encryptionKey: input.encryptionKey,
    host: input.host,
    ...(input.fetcher ? { fetcher: input.fetcher } : {}),
  });
}
