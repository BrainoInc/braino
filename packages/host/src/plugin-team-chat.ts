import type { PoolClient } from "@braino/db";
import type {
  EventReceiveCapability,
  PluginEventRequest,
  PluginManifest,
  TeamChatConnectCapability,
  TeamChatConnectRequest,
  TeamChatConnectResponse,
  TeamChatMessage,
  TeamChatSendCapability,
} from "@braino/plugin-runtime";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
} from "./plugin-installations.js";
import { type PluginHostConnection, invokePlugin } from "./plugin-invocation.js";

type Fetcher = typeof fetch;

interface TeamChatInstallationRow {
  id: string;
  plugin_id: string;
}

/** The provider-neutral team-chat boundary used by Señor Braino. */
export class PluginTeamChatProvider
  implements TeamChatConnectCapability, EventReceiveCapability, TeamChatSendCapability
{
  constructor(
    private readonly client: PoolClient,
    readonly installation: {
      workspaceId: string;
      installationId: string;
      pluginId: string;
    },
    private readonly connection: {
      encryptionKey: string;
      host: PluginHostConnection;
      fetcher?: Fetcher;
    },
  ) {}

  private invoke(
    capability: "event.receive" | "team_chat.connect" | "team_chat.send",
    input: unknown,
  ) {
    return invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability,
      input,
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    });
  }

  async connect(input: TeamChatConnectRequest) {
    return (await this.invoke("team_chat.connect", input)) as Awaited<
      ReturnType<TeamChatConnectCapability["connect"]>
    >;
  }

  async receive(input: PluginEventRequest) {
    return (await this.invoke("event.receive", input)) as Awaited<
      ReturnType<EventReceiveCapability["receive"]>
    >;
  }

  async send(input: TeamChatMessage) {
    return (await this.invoke("team_chat.send", input)) as Awaited<
      ReturnType<TeamChatSendCapability["send"]>
    >;
  }
}

/** Resolve the one enabled plugin that owns the complete team-chat contract. */
export async function resolveWorkspaceTeamChatPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginTeamChatProvider | null> {
  const found = await client.query<TeamChatInstallationRow>(
    `SELECT id, manifest->>'id' AS plugin_id
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND manifest->'capabilities' ?& ARRAY['event.receive', 'team_chat.connect', 'team_chat.send']
      ORDER BY id`,
    [input.workspaceId],
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1) {
    throw new PluginInstallationError(
      "Only one team-chat plugin can be enabled per workspace.",
      "team_chat_plugin_ambiguous",
      409,
    );
  }
  const row = found.rows[0];
  if (!row) return null;
  return new PluginTeamChatProvider(
    client,
    {
      workspaceId: input.workspaceId,
      installationId: row.id,
      pluginId: row.plugin_id,
    },
    {
      encryptionKey: input.encryptionKey,
      host: input.host,
      ...(input.fetcher ? { fetcher: input.fetcher } : {}),
    },
  );
}

/** Install, live-verify, and exclusively assign one team-chat provider atomically. */
export async function connectWorkspaceTeamChatPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    manifest: PluginManifest;
    component: Uint8Array;
    configuration?: unknown;
    secrets: Readonly<Record<string, string>>;
    encryptionKey: string;
    host: PluginHostConnection;
    connectionInput: TeamChatConnectRequest;
    fetcher?: Fetcher;
  },
): Promise<{ installation: PluginInstallation; connection: TeamChatConnectResponse }> {
  await client.query("BEGIN");
  try {
    const installation = await installPluginInTransaction(client, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      manifest: input.manifest,
      component: input.component,
      configuration: input.configuration ?? {},
      secrets: input.secrets,
      encryptionKey: input.encryptionKey,
    });
    await client.query(
      `UPDATE plugin_installations
          SET enabled = false, updated_by_user_id = $3, updated_at = now()
        WHERE workspace_id = $1 AND id <> $2 AND enabled
          AND manifest->'capabilities' ?& ARRAY['event.receive', 'team_chat.connect', 'team_chat.send']`,
      [input.workspaceId, installation.id, input.userId],
    );
    const plugin = new PluginTeamChatProvider(
      client,
      {
        workspaceId: input.workspaceId,
        installationId: installation.id,
        pluginId: installation.manifest.id,
      },
      {
        encryptionKey: input.encryptionKey,
        host: input.host,
        ...(input.fetcher ? { fetcher: input.fetcher } : {}),
      },
    );
    const connection = await plugin.connect(input.connectionInput);
    await client.query("COMMIT");
    return { installation, connection };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
