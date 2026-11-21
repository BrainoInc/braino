import { connectorPlugin } from "@doco/connector-plugins";
import { withClient } from "@doco/db";
import {
  type ConnectorConnectionSummary,
  connectConnector,
  createIncomingWebhook,
  disconnectConnector,
  getSingleWorkspaceState,
  listConnectorConnections,
  listGithubConnections,
  listIncomingWebhooks,
  revokeIncomingWebhook,
  syncConnectorConnection,
} from "@doco/host";
import { msg } from "@doco/shared/i18n";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

interface ActionData {
  webhookUrl?: string;
  message?: string;
  error?: string;
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Sources · Braino") }];
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const loaded = await withClient(async (client) => {
    const membership = await client.query<{ role: string }>(
      "SELECT role FROM workspace_users WHERE workspace_id = $1 AND user_id = $2",
      [state.workspace.id, user.id],
    );
    if (membership.rows[0]?.role !== "owner") {
      throw new Response("Owner access required", { status: 403 });
    }
    const collections = await client.query<{ id: string; handle: string }>(
      `SELECT id, handle FROM collections
        WHERE workspace_id = $1 AND deleted_at IS NULL ORDER BY handle`,
      [state.workspace.id],
    );
    return {
      collections: collections.rows,
      connectorConnections: await listConnectorConnections(client, state.workspace.id, user.id),
      githubConnections: await listGithubConnections(client, state.workspace.id, user.id),
      webhooks: await listIncomingWebhooks(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
      }),
    };
  });
  const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
  return { workspace: state.workspace, publicHost, ...loaded };
}

function text(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function encryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error(msg("DOCO_ENCRYPTION_KEY must contain at least 32 characters."));
  }
  return value;
}

export async function action({ request }: { request: Request }): Promise<ActionData | Response> {
  const t = await requestTranslator(request);
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: t("Sign in first.") }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized)
    return Response.json({ error: t("Finish setup first.") }, { status: 409 });
  const form = await request.formData();
  const intent = text(form, "intent");

  if (intent === "connect_slack") {
    try {
      const plugin = connectorPlugin("slack");
      const connected = await connectConnector(withClient, {
        workspaceId: state.workspace.id,
        userId: user.id,
        credential: text(form, "bot_token"),
        encryptionKey: encryptionKey(),
        adapter: plugin.adapter,
      });
      const synced = await syncConnectorConnection(withClient, {
        connectionId: connected.id,
        encryptionKey: encryptionKey(),
        userId: user.id,
        adapter: plugin.adapter,
      });
      return {
        message: t(
          "Connected {name}. Imported {count, plural, one {# Slack message} other {# Slack messages}}.",
          { name: connected.sourceName, count: synced.created },
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? t(error.message) : t("Could not connect Slack.") };
    }
  }

  if (intent === "connect_notion") {
    try {
      const plugin = connectorPlugin("notion");
      const connected = await connectConnector(withClient, {
        workspaceId: state.workspace.id,
        userId: user.id,
        credential: text(form, "notion_token"),
        encryptionKey: encryptionKey(),
        adapter: plugin.adapter,
      });
      const synced = await syncConnectorConnection(withClient, {
        connectionId: connected.id,
        encryptionKey: encryptionKey(),
        userId: user.id,
        adapter: plugin.adapter,
      });
      return {
        message: t(
          "Connected {name}. Imported {count, plural, one {# Notion page} other {# Notion pages}}.",
          { name: connected.sourceName, count: synced.created },
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? t(error.message) : t("Could not connect Notion.") };
    }
  }

  if (intent === "connect_google_drive") {
    try {
      const plugin = connectorPlugin("google_drive");
      const connected = await connectConnector(withClient, {
        workspaceId: state.workspace.id,
        userId: user.id,
        credential: text(form, "service_account_json"),
        encryptionKey: encryptionKey(),
        adapter: plugin.adapter,
      });
      const synced = await syncConnectorConnection(withClient, {
        connectionId: connected.id,
        encryptionKey: encryptionKey(),
        userId: user.id,
        adapter: plugin.adapter,
      });
      return {
        message: t(
          "Connected {name}. Imported {count, plural, one {# Google Drive file} other {# Google Drive files}}.",
          { name: connected.sourceName, count: synced.created },
        ),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? t(error.message) : t("Could not connect Google Drive."),
      };
    }
  }

  if (intent === "sync_connector") {
    try {
      const provider = text(form, "provider");
      const plugin = connectorPlugin(provider);
      const synced = await syncConnectorConnection(withClient, {
        connectionId: text(form, "connection_id"),
        encryptionKey: encryptionKey(),
        userId: user.id,
        adapter: plugin.adapter,
      });
      return {
        message: t(
          "{connector} sync complete: {created} created, {updated} updated, {retired} retired, {unchanged} unchanged.",
          {
            connector: plugin.label,
            created: synced.created,
            updated: synced.updated,
            retired: synced.retired,
            unchanged: synced.unchanged,
          },
        ),
      };
    } catch (error) {
      return { error: error instanceof Error ? t(error.message) : t("Could not sync connector.") };
    }
  }

  if (intent === "disconnect_connector") {
    try {
      const provider = text(form, "provider");
      const plugin = connectorPlugin(provider);
      await withClient((client) =>
        disconnectConnector(client, {
          connectionId: text(form, "connection_id"),
          userId: user.id,
        }),
      );
      return {
        message: t("{connector} disconnected. Imported records and history were kept.", {
          connector: plugin.label,
        }),
      };
    } catch (error) {
      return {
        error: error instanceof Error ? t(error.message) : t("Could not disconnect connector."),
      };
    }
  }

  if (intent === "create_webhook") {
    try {
      const created = await withClient((client) =>
        createIncomingWebhook(client, {
          workspaceId: state.workspace.id,
          collectionId: text(form, "collection_id"),
          userId: user.id,
          label: text(form, "label"),
        }),
      );
      const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
        /\/$/,
        "",
      );
      return { webhookUrl: `${publicHost}/api/v1/webhooks/${created.accessToken}` };
    } catch (error) {
      return { error: error instanceof Error ? t(error.message) : t("Could not create webhook.") };
    }
  }

  if (intent === "revoke_webhook") {
    await withClient((client) =>
      revokeIncomingWebhook(client, { tokenId: text(form, "token_id"), userId: user.id }),
    );
    return redirect("/integrations");
  }
  return Response.json({ error: t("Unknown integration action.") }, { status: 400 });
}

function NotionConnectionForm({ reconnect = false }: { reconnect?: boolean }) {
  const t = useT();
  const navigation = useNavigation();
  const connecting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "connect_notion";
  return (
    <Form method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="intent" value="connect_notion" />
      <label className="text-xs sm:col-span-2">
        <span className="mb-1 block text-muted-foreground">{t("Notion integration token")}</span>
        <input
          name="notion_token"
          type="password"
          required
          autoComplete="new-password"
          placeholder={t("ntn_… or secret_…")}
          className="w-full rounded-md px-3 py-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {t(
          "Create an internal Notion integration with read content access, share the pages you want with it, then paste its token here. Only pages shared with that integration are copied.",
        )}
      </p>
      <div className="sm:col-span-2 sm:text-end">
        <button
          type="submit"
          disabled={connecting}
          className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {connecting
            ? t("Connecting…")
            : reconnect
              ? t("Reconnect Notion")
              : t("Connect and sync")}
        </button>
      </div>
    </Form>
  );
}

function GoogleDriveConnectionForm({ reconnect = false }: { reconnect?: boolean }) {
  const t = useT();
  const navigation = useNavigation();
  const connecting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "connect_google_drive";
  return (
    <Form method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="intent" value="connect_google_drive" />
      <label className="text-xs sm:col-span-2">
        <span className="mb-1 block text-muted-foreground">{t("Google service-account JSON")}</span>
        <textarea
          name="service_account_json"
          required
          rows={7}
          autoComplete="off"
          placeholder={'{"type":"service_account", …}'}
          className="w-full rounded-md px-3 py-2 font-mono text-xs"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {t(
          "Enable the Google Drive API, create a service-account key, and share the folders or files with its client_email address. Braino imports Google Docs, Sheets, Slides, and text files; the private key is encrypted at rest.",
        )}
      </p>
      <div className="sm:col-span-2 sm:text-end">
        <button
          type="submit"
          disabled={connecting}
          className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {connecting
            ? t("Connecting…")
            : reconnect
              ? t("Reconnect Google Drive")
              : t("Connect and sync")}
        </button>
      </div>
    </Form>
  );
}

function SlackConnectionForm({ reconnect = false }: { reconnect?: boolean }) {
  const t = useT();
  const navigation = useNavigation();
  const connecting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "connect_slack";
  return (
    <Form method="post" className="grid gap-3 sm:grid-cols-2">
      <input type="hidden" name="intent" value="connect_slack" />
      <label className="text-xs sm:col-span-2">
        <span className="mb-1 block text-muted-foreground">{t("Slack bot token")}</span>
        <input
          name="bot_token"
          type="password"
          required
          autoComplete="new-password"
          placeholder={"xoxb-…"}
          className="w-full rounded-md px-3 py-2 font-mono text-sm"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        {t(
          "Use a bot token with channels:read, channels:history, and users:read. Braino copies public, non-shared channels only and encrypts the token with this deployment's encryption key.",
        )}
      </p>
      <div className="sm:col-span-2 sm:text-end">
        <button
          type="submit"
          disabled={connecting}
          className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
        >
          {connecting ? t("Connecting…") : reconnect ? t("Reconnect Slack") : t("Connect and sync")}
        </button>
      </div>
    </Form>
  );
}

function ConnectorConnection({
  connection,
  collectionLabel,
  reconnect,
}: {
  connection: ConnectorConnectionSummary;
  collectionLabel: string;
  reconnect: "slack" | "notion" | "google_drive";
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{connection.sourceName}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {connection.active
              ? connection.lastSyncedAt
                ? t("Last synced {when}", {
                    when: new Date(connection.lastSyncedAt).toLocaleString(t.locale),
                  })
                : t("Connected; first sync pending")
              : t("Disconnected")}
          </p>
          {connection.lastError ? (
            <p className="mt-1 text-xs text-destructive">{connection.lastError}</p>
          ) : null}
        </div>
        {connection.active ? (
          <div className="flex gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="sync_connector" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <input type="hidden" name="provider" value={connection.provider} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold"
              >
                {t("Sync now")}
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect_connector" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <input type="hidden" name="provider" value={connection.provider} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
              >
                {t("Disconnect")}
              </button>
            </Form>
          </div>
        ) : null}
      </div>
      <Link
        className="neu-button inline-flex rounded-md px-3 py-2 text-xs font-semibold"
        to={`/${connection.collectionHandle}`}
      >
        {collectionLabel}
      </Link>
      {!connection.active ? (
        reconnect === "slack" ? (
          <SlackConnectionForm reconnect />
        ) : reconnect === "notion" ? (
          <NotionConnectionForm reconnect />
        ) : (
          <GoogleDriveConnectionForm reconnect />
        )
      ) : null}
    </div>
  );
}

export default function IntegrationsPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as ActionData | undefined;
  const slackConnection = data.connectorConnections.find(
    (connection) => connection.provider === "slack",
  );
  const notionConnection = data.connectorConnections.find(
    (connection) => connection.provider === "notion",
  );
  const googleDriveConnection = data.connectorConnections.find(
    (connection) => connection.provider === "google_drive",
  );
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              {"Braino"}
            </Link>
            <span aria-hidden>›</span>
            <span>{data.workspace.handle}</span>
            <span aria-hidden>›</span>
            <Link to="/admin" className="hover:underline">
              {t("Admin")}
            </Link>
            <span aria-hidden>›</span>
            <span>{t("Sources")}</span>
          </nav>
        }
        title={t("Sources")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Connect sources, GitHub, and webhooks.")}
        </p>
      </PageHeader>

      {actionData?.webhookUrl ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("Copy this webhook URL now")}</CardTitle>
            <CardDescription>
              {t(
                "The secret URL is shown once. Send JSON changesets with a unique Idempotency-Key header.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <textarea
              readOnly
              rows={3}
              value={actionData.webhookUrl}
              aria-label={t("Incoming webhook URL")}
              className="w-full rounded-md px-3 py-2 font-mono text-xs"
            />
          </CardContent>
        </Card>
      ) : null}
      {actionData?.message ? <p className="text-sm text-foreground">{actionData.message}</p> : null}
      {actionData?.error ? <p className="text-sm text-destructive">{actionData.error}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>{"Slack channel import"}</CardTitle>
          <CardDescription>
            {t(
              "Copy one Slack workspace's public channels into a private Braino collection. Private, archived, and Slack Connect channels are never imported.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {slackConnection ? (
            <ConnectorConnection
              connection={slackConnection}
              collectionLabel={t("Slack messages")}
              reconnect="slack"
            />
          ) : (
            <SlackConnectionForm />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{"Notion"}</CardTitle>
          <CardDescription>
            {t(
              "Copy the pages shared with one Notion integration into a private Braino collection, including nested block content and page properties.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {notionConnection ? (
            <ConnectorConnection
              connection={notionConnection}
              collectionLabel={t("Notion pages")}
              reconnect="notion"
            />
          ) : (
            <NotionConnectionForm />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{"Google Drive"}</CardTitle>
          <CardDescription>
            {t(
              "Copy the Workspace documents and text files shared with one service account into a private Braino collection. Binary files and folders are ignored.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {googleDriveConnection ? (
            <ConnectorConnection
              connection={googleDriveConnection}
              collectionLabel={t("Google Drive files")}
              reconnect="google_drive"
            />
          ) : (
            <GoogleDriveConnectionForm />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Braino for GitHub")}</CardTitle>
          <CardDescription>
            {t(
              "Install the official Braino GitHub App to import code, issues, and pull requests, publish Braino checks, and optionally require Braino before merging.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link
            to="/integrations/github-app"
            className="neu-button inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {data.githubConnections.some((connection) => connection.gatewayConnected)
              ? t("Manage GitHub App")
              : data.githubConnections.length
                ? t("Migrate to GitHub App")
                : t("Connect GitHub App")}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("New incoming webhook")}</CardTitle>
          <CardDescription>
            {t(
              "Choose its destination. Every delivery uses that collection's authoring policies and immutable history.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="create_webhook" />
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">{t("Name")}</span>
              <input
                name="label"
                required
                maxLength={100}
                className="w-full rounded-md px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">{t("Collection")}</span>
              <select name="collection_id" className="w-full rounded-md px-3 py-2 text-sm">
                {data.collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.handle}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2 sm:text-end">
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {t("Create webhook")}
              </button>
            </div>
          </Form>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("Incoming webhooks")}</h2>
        {data.webhooks.length ? (
          data.webhooks.map((webhook) => (
            <Card key={webhook.tokenId}>
              <CardContent className="flex flex-wrap items-center gap-3 pt-4">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">{webhook.label}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {webhook.collectionHandle} ·{" "}
                    {webhook.revoked
                      ? t("revoked")
                      : webhook.lastUsedAt
                        ? t("last used {when}", {
                            when: new Date(webhook.lastUsedAt).toLocaleString(t.locale),
                          })
                        : t("never used")}
                  </p>
                </div>
                {!webhook.revoked ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="revoke_webhook" />
                    <input type="hidden" name="token_id" value={webhook.tokenId} />
                    <button
                      type="submit"
                      className="neu-button rounded-md px-3 py-2 text-xs font-semibold text-destructive"
                    >
                      {t("Revoke")}
                    </button>
                  </Form>
                ) : null}
              </CardContent>
            </Card>
          ))
        ) : (
          <p className="text-sm italic text-muted-foreground">{t("No incoming webhooks yet.")}</p>
        )}
      </section>
    </PageMain>
  );
}
