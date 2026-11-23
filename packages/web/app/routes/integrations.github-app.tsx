import { withClient } from "@doco/db";
import {
  GithubConnectionError,
  type GithubConnectionSummary,
  connectGithubRepositoryWithPlugin,
  disconnectGithubRepository,
  finishGithubGatewayMigration,
  getSingleWorkspaceState,
  getWorkspaceRole,
  listGithubConnections,
  resolveWorkspaceGithubPlugin,
  syncGithubConnection,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@doco/ui";
import { PageHeader } from "@doco/ui";
import { PageMain } from "@doco/ui";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  brainoPluginGatewayUrl,
  createPluginGatewayState,
} from "~/lib/plugin-gateway-state.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function githubContext(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const role = await withClient((client) => getWorkspaceRole(client, state.workspace.id, user.id));
  if (role !== "owner") throw new Response("Owner access required", { status: 403 });
  return { user, workspace: state.workspace };
}

function pluginConfiguration() {
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  return { encryptionKey, host };
}

export async function loader({ request }: { request: Request }) {
  const { user, workspace } = await githubContext(request);
  const { encryptionKey, host } = pluginConfiguration();
  const loaded = await withClient(async (client) => {
    const connections = await listGithubConnections(client, workspace.id, user.id);
    if (!encryptionKey || !host) return { connections, plugin: null, repositories: [] };
    const plugin = await resolveWorkspaceGithubPlugin(client, {
      workspaceId: workspace.id,
      encryptionKey,
      host,
    });
    return {
      connections,
      plugin,
      repositories: plugin ? await plugin.repositories() : [],
    };
  });
  const origin = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(/\/+$/, "");
  let installUrl: string | null = null;
  if (!loaded.plugin && encryptionKey && origin.startsWith("https://")) {
    const url = new URL("/v1/providers/github/install", brainoPluginGatewayUrl());
    url.searchParams.set(
      "callback_url",
      new URL("/integrations/github-app/callback", origin).toString(),
    );
    url.searchParams.set(
      "state",
      createPluginGatewayState(
        { provider: "github", userId: user.id, workspaceId: workspace.id },
        encryptionKey,
      ),
    );
    installUrl = url.toString();
  }
  return {
    workspace,
    connections: loaded.connections,
    repositories: loaded.repositories,
    connected: Boolean(loaded.plugin),
    installUrl,
    secure: origin.startsWith("https://"),
    configured: Boolean(encryptionKey && host),
  };
}

async function withGithubPlugin<T>(
  workspaceId: string,
  callback: (
    plugin: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceGithubPlugin>>>,
  ) => Promise<T>,
): Promise<T> {
  const { encryptionKey, host } = pluginConfiguration();
  if (!encryptionKey || !host) {
    throw new GithubConnectionError(
      "The plugin service is not configured.",
      "plugin_unavailable",
      503,
    );
  }
  return withClient(async (client) => {
    const plugin = await resolveWorkspaceGithubPlugin(client, { workspaceId, encryptionKey, host });
    if (!plugin) {
      throw new GithubConnectionError(
        "Install the Braino GitHub App first.",
        "github_app_required",
        409,
      );
    }
    return callback(plugin);
  });
}

export async function action({ request }: { request: Request }) {
  const { user, workspace } = await githubContext(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: error.message };
    throw error;
  }
  const intent = text(form, "intent");
  try {
    if (intent === "connect_repository") {
      return await withGithubPlugin(workspace.id, async (plugin) => {
        const connection = await connectGithubRepositoryWithPlugin(withClient, {
          workspaceId: workspace.id,
          userId: user.id,
          repository: text(form, "repository"),
          plugin,
        });
        await syncGithubConnection(withClient, {
          connectionId: connection.id,
          plugin,
          userId: user.id,
        });
        await finishGithubGatewayMigration(withClient, {
          connectionId: connection.id,
          pluginInstallationId: plugin.installation.installationId,
        });
        return redirect("/integrations/github-app?synced=1");
      });
    }
    if (intent === "sync") {
      return await withGithubPlugin(workspace.id, async (plugin) => {
        await syncGithubConnection(withClient, {
          connectionId: text(form, "connection_id"),
          plugin,
          userId: user.id,
        });
        return redirect("/integrations/github-app?synced=1");
      });
    }
    if (intent === "disconnect") {
      const encryptionKey = pluginSecretsKey();
      if (!encryptionKey) throw new Error("The encryption key is not configured.");
      await disconnectGithubRepository(withClient, {
        connectionId: text(form, "connection_id"),
        userId: user.id,
        encryptionKey,
      });
      return redirect("/integrations/github-app?disconnected=1");
    }
    return { error: "Unsupported action." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "GitHub operation failed." };
  }
}

export function githubRulesUrl(repository: string): string {
  return `https://github.com/${repository}/settings/rules`;
}

function Connection({ connection }: { connection: GithubConnectionSummary }) {
  const t = useT();
  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold">{connection.repository}</p>
          <p className="text-xs text-muted-foreground">
            {connection.gatewayConnected
              ? t("Connected through the Braino GitHub App")
              : t("Personal access token migration required")}
          </p>
          {connection.lastSyncedAt ? (
            <p className="text-xs text-muted-foreground">
              {t("Last synced {when}", {
                when: new Date(connection.lastSyncedAt).toLocaleString(t.locale),
              })}
            </p>
          ) : null}
          {connection.lastError ? (
            <p className="text-xs text-destructive">{connection.lastError}</p>
          ) : null}
        </div>
        {connection.active && connection.gatewayConnected ? (
          <div className="flex flex-wrap gap-2">
            <Form method="post">
              <input type="hidden" name="intent" value="sync" />
              <input type="hidden" name="connection_id" value={connection.id} />
              <button
                type="submit"
                className="neu-button rounded-md px-3 py-2 text-xs font-semibold"
              >
                {t("Sync now")}
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect" />
              <input type="hidden" name="connection_id" value={connection.id} />
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
      {connection.active && connection.gatewayConnected ? (
        <div className="space-y-2 rounded-md border p-3 text-xs">
          <p className="font-semibold">{t("Require Braino before merging")}</p>
          <p className="text-muted-foreground">
            {t(
              "GitHub controls whether the Braino check blocks merging. Add Braino as a required status check in each repository you want to protect.",
            )}
          </p>
          <ol className="list-decimal space-y-1 ps-5 text-muted-foreground">
            <li>{t("Open the repository's rulesets settings on GitHub.")}</li>
            <li>{t("Edit the branch ruleset that protects the default branch.")}</li>
            <li>{t('Turn on "Require status checks to pass" and add "Braino".')}</li>
            <li>{t('Leave "Require branches to be up to date before merging" off.')}</li>
          </ol>
          <a
            className="neu-button inline-flex rounded-md px-3 py-2 font-semibold"
            href={githubRulesUrl(connection.repository)}
            target="_blank"
            rel="noreferrer"
          >
            {t("Configure in GitHub")}
          </a>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2 text-xs">
        <Link
          className="neu-button rounded-md px-3 py-2 font-semibold"
          to={`/${connection.issuesCollectionHandle}`}
        >
          {t("GitHub issues")}
        </Link>
        <Link
          className="neu-button rounded-md px-3 py-2 font-semibold"
          to={`/${connection.pullRequestsCollectionHandle}`}
        >
          {t("GitHub pull requests")}
        </Link>
        <Link
          className="neu-button rounded-md px-3 py-2 font-semibold"
          to={`/${connection.codeCollectionHandle}`}
        >
          {t("Codebase")}
        </Link>
      </div>
    </div>
  );
}

export default function GithubAppPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  const active = data.connections.find((connection) => connection.active);
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <Link to="/admin">{t("Admin")}</Link>
            <span aria-hidden>›</span>
            <Link to="/integrations">{t("Sources")}</Link>
            <span aria-hidden>›</span>
            <span>{t("GitHub App")}</span>
          </nav>
        }
        title={t("Connect Braino to GitHub")}
      >
        <p className="text-xs text-muted-foreground">
          {t(
            "Install the official Braino GitHub App. GitHub credentials stay in the Braino plugin gateway; this workspace receives only its scoped connection.",
          )}
        </p>
      </PageHeader>

      {!data.secure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t("GitHub requires a public HTTPS address. Set DOCO_PUBLIC_HOST before connecting.")}
        </p>
      ) : null}
      {!data.configured ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t("The plugin host and secret key must be configured before connecting GitHub.")}
        </p>
      ) : null}
      {actionData?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionData.error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>
            {data.connected ? t("GitHub App installed") : t("Install the Braino GitHub App")}
          </CardTitle>
          <CardDescription>
            {t(
              "Choose the repositories Braino may read, check, and review. No personal access token is stored here.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!data.connected && data.installUrl ? (
            <a
              href={data.installUrl}
              className="neu-button inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t("Install GitHub App")}
            </a>
          ) : data.connected && (!active || !active.gatewayConnected) ? (
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="connect_repository" />
              <label className="min-w-64 flex-1 text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Repository")}</span>
                <select
                  name="repository"
                  required
                  defaultValue={active?.repository ?? ""}
                  className="w-full rounded-md px-3 py-2 font-mono text-sm"
                >
                  <option value="" disabled>
                    {t("Choose a repository")}
                  </option>
                  {data.repositories.map((repository) => (
                    <option key={repository.fullName} value={repository.fullName}>
                      {repository.fullName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {active ? t("Migrate and sync") : t("Connect and sync")}
              </button>
            </Form>
          ) : null}
        </CardContent>
      </Card>

      {data.connections.map((connection) => (
        <Connection key={connection.id} connection={connection} />
      ))}
    </PageMain>
  );
}
