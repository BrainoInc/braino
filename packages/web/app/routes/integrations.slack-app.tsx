import { withClient } from "@doco/db";
import {
  PluginInstallationError,
  connectWorkspaceTeamChatPlugin,
  getSingleWorkspaceState,
  getWorkspaceRole,
  listPluginInstallations,
  resolveWorkspaceTeamChatPlugin,
  setPluginInstallationEnabled,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { bundledPlugin } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { slackAppBootstrapManifest, slackAppManifest } from "~/lib/slack-app-manifest";

const SLACK_PLUGIN_ID = "braino.slack";

interface SlackContext {
  user: { id: string; email: string };
  workspace: { id: string; handle: string; name: string };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function slackContext(request: Request): Promise<SlackContext> {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const role = await withClient((client) => getWorkspaceRole(client, state.workspace.id, user.id));
  if (role !== "owner") throw new Response("Owner access required", { status: 403 });
  return { user, workspace: state.workspace };
}

export async function loader({ request }: { request: Request }) {
  const { user, workspace } = await slackContext(request);
  const installations = await withClient((client) =>
    listPluginInstallations(client, { workspaceId: workspace.id, userId: user.id }),
  );
  const installation = installations.find(
    (candidate) => candidate.manifest.id === SLACK_PLUGIN_ID && candidate.enabled,
  );
  const origin = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(/\/+$/, "");
  return {
    workspace,
    installationId: installation?.id ?? null,
    connected: Boolean(installation),
    secure: origin.startsWith("https://"),
    eventUrl: new URL("/api/v1/plugins/slack/events", origin).toString(),
    manifest: JSON.stringify(
      installation ? slackAppManifest(origin) : slackAppBootstrapManifest(),
      null,
      2,
    ),
  };
}

export async function action({ request }: { request: Request }) {
  const { user, workspace } = await slackContext(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: error.message };
    throw error;
  }

  if (text(form, "intent") === "disconnect") {
    await withClient((client) =>
      setPluginInstallationEnabled(client, {
        workspaceId: workspace.id,
        userId: user.id,
        installationId: text(form, "installation_id"),
        enabled: false,
      }),
    );
    return redirect("/integrations/slack-app?disconnected=1");
  }

  const botToken = text(form, "bot_token");
  const signingSecret = text(form, "signing_secret");
  if (!botToken || !signingSecret) return { error: "Enter the bot token and signing secret." };
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) return { error: "The plugin service is not configured." };
  const bundled = await bundledPlugin(SLACK_PLUGIN_ID);
  if (!bundled) return { error: "The Slack plugin is not included in this Braino image." };

  try {
    await withClient(async (client) => {
      const connected = await connectWorkspaceTeamChatPlugin(client, {
        workspaceId: workspace.id,
        userId: user.id,
        manifest: bundled.manifest,
        component: bundled.component,
        secrets: { bot_token: botToken, signing_secret: signingSecret },
        encryptionKey,
        host,
        connectionInput: {
          installer: { email: user.email },
          introductionChannel: text(form, "introduction_channel") || "general",
        },
      });
      const provider = await resolveWorkspaceTeamChatPlugin(client, {
        workspaceId: workspace.id,
        encryptionKey,
        host,
      });
      if (!provider) throw new Error("The Slack plugin was not enabled.");
      const requested = (text(form, "introduction_channel") || "general").replace(/^#/, "");
      const channel = connected.connection.channels.find(
        (candidate) => candidate.name === requested,
      );
      if (channel) {
        await provider.send({
          target: { kind: "channel", id: channel.id },
          text: "👋 I’m Señor Braino. Mention me or message me directly to ask about this Braino workspace.",
        });
      }
      if (connected.connection.installerUserId) {
        await provider.send({
          target: { kind: "user", id: connected.connection.installerUserId },
          text: `Señor Braino is connected to ${workspace.name}. Ask me about decisions, rules, and current work.`,
        });
      }
    });
  } catch (error) {
    if (error instanceof PluginInstallationError) return { error: error.message };
    throw error;
  }
  return redirect("/integrations/slack-app?connected=1");
}

export default function SlackAppPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  const [copied, setCopied] = useState(false);
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <Link to="/admin">{t("Admin")}</Link>
            <span aria-hidden>›</span>
            <Link to="/integrations">{t("Integrations")}</Link>
            <span aria-hidden>›</span>
            <span>{t("Slack app")}</span>
          </nav>
        }
        title={t("Connect Señor Braino to Slack")}
      >
        <p className="text-xs text-muted-foreground">
          {t(
            "One private Slack app connects directly to this Braino instance. Messages and credentials never pass through another Braino deployment.",
          )}
        </p>
      </PageHeader>

      {!data.secure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t(
            "Slack requires a public HTTPS address. Set DOCO_PUBLIC_HOST before connecting this app.",
          )}
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
            {data.connected
              ? t("3. Activate Slack events")
              : t("1. Create your Slack app")}
          </CardTitle>
          <CardDescription>
            {data.connected
              ? t(
                  "Replace the app manifest in Slack with this final version. Slack will verify the direct Braino endpoint.",
                )
              : t(
                  "In Slack, choose Create New App → From an app manifest, then paste this bootstrap manifest.",
                )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <textarea
            readOnly
            rows={18}
            value={data.manifest}
            aria-label={t("Slack app manifest")}
            className="w-full rounded-md px-3 py-2 font-mono text-xs"
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
              onClick={async () => {
                await navigator.clipboard.writeText(data.manifest);
                setCopied(true);
              }}
            >
              {copied ? t("Copied") : t("Copy manifest")}
            </button>
            {!data.connected ? (
              <a
                href="https://api.slack.com/apps?new_app=1"
                target="_blank"
                rel="noreferrer"
                className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
              >
                {t("Open Slack app builder")}
              </a>
            ) : null}
          </div>
          {data.connected ? (
            <p className="break-all font-mono text-xs">
              {t("Event URL:")} {data.eventUrl}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {data.connected ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("Señor Braino is connected")}</CardTitle>
            <CardDescription>
              {t(
                "Finish step 3 above once, then mention Señor Braino in a channel or send it a direct message.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect" />
              <input type="hidden" name="installation_id" value={data.installationId ?? ""} />
              <button
                type="submit"
                className="neu-button rounded-md px-4 py-2 text-sm text-destructive"
              >
                {t("Disconnect Slack")}
              </button>
            </Form>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("2. Install and connect")}</CardTitle>
            <CardDescription>
              {t(
                "Install the app to your Slack workspace. Paste its Bot User OAuth Token and Basic Information → Signing Secret here.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="connect" />
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">
                  {t("Bot User OAuth Token")}
                </span>
                <input
                  required
                  type="password"
                  name="bot_token"
                  autoComplete="off"
                  className="w-full rounded-md px-3 py-2 font-mono"
                  placeholder={"xoxb-…"}
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">{t("Signing Secret")}</span>
                <input
                  required
                  type="password"
                  name="signing_secret"
                  autoComplete="off"
                  className="w-full rounded-md px-3 py-2 font-mono"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">
                  {t("Introduction channel")}
                </span>
                <input
                  name="introduction_channel"
                  defaultValue="general"
                  className="w-full rounded-md px-3 py-2"
                />
              </label>
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {t("Connect Señor Braino")}
              </button>
            </Form>
          </CardContent>
        </Card>
      )}
    </PageMain>
  );
}
