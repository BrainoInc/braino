import type { PoolClient } from "@doco/db";
import type {
  EmailMessage,
  EmailSendCapability,
  EmailSendResponse,
  PluginManifest,
} from "@doco/plugin-runtime";
import {
  type PluginInstallation,
  PluginInstallationError,
  installPluginInTransaction,
} from "./plugin-installations.js";
import { type PluginHostConnection, invokePlugin } from "./plugin-invocation.js";

type Fetcher = typeof fetch;

interface EmailInstallationRow {
  id: string;
  plugin_id: string;
}

/** The provider-neutral email boundary used by Braino application code. */
export class PluginEmailProvider implements EmailSendCapability {
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

  async send(input: EmailMessage): Promise<EmailSendResponse> {
    return (await invokePlugin(this.client, {
      workspaceId: this.installation.workspaceId,
      installationId: this.installation.installationId,
      capability: "email.send",
      input,
      encryptionKey: this.connection.encryptionKey,
      host: this.connection.host,
      ...(this.connection.fetcher ? { fetcher: this.connection.fetcher } : {}),
    })) as EmailSendResponse;
  }
}

/** Resolve the one enabled email provider for this workspace. */
export async function resolveWorkspaceEmailPlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<PluginEmailProvider | null> {
  const found = await client.query<EmailInstallationRow>(
    `SELECT id, manifest->>'id' AS plugin_id
       FROM plugin_installations
      WHERE workspace_id = $1 AND enabled
        AND manifest->'capabilities' ? 'email.send'
      ORDER BY id`,
    [input.workspaceId],
  );
  if (found.rows.length === 0) return null;
  if (found.rows.length > 1) {
    throw new PluginInstallationError(
      "Only one email plugin can be enabled per workspace.",
      "email_plugin_ambiguous",
      409,
    );
  }
  const row = found.rows[0];
  if (!row) return null;
  return new PluginEmailProvider(
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

/** Install, live-verify, and exclusively assign one email provider atomically. */
export async function connectWorkspaceEmailPlugin(
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
    verificationRecipient: string;
    fetcher?: Fetcher;
  },
): Promise<{ installation: PluginInstallation; verification: EmailSendResponse }> {
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
          AND manifest->'capabilities' ? 'email.send'`,
      [input.workspaceId, installation.id, input.userId],
    );
    const plugin = new PluginEmailProvider(
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
    const verification = await plugin.send({
      to: [input.verificationRecipient],
      subject: "Your Braino email provider is connected",
      text: "Braino successfully sent this message through your installed email plugin.",
    });
    await client.query("COMMIT");
    return { installation, verification };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
