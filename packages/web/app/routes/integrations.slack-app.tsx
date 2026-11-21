import { withClient } from "@doco/db";
import {
  getSingleWorkspaceState,
  getWorkspaceRole,
  listPluginInstallations,
  setPluginInstallationEnabled,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginSecretsKey } from "~/lib/model-setup.server";
import {
  brainoPluginGatewayUrl,
  createPluginGatewayState,
} from "~/lib/plugin-gateway-state.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

const SLACK_PLUGIN_ID = "braino.slack";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function slackContext(request: Request) {
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
  const stateSecret = pluginSecretsKey();
  let installUrl: string | null = null;
  if (!installation && stateSecret && origin.startsWith("https://")) {
    const gateway = brainoPluginGatewayUrl();
    const url = new URL("/v1/providers/slack/install", gateway);
    url.searchParams.set(
      "callback_url",
      new URL("/integrations/slack-app/callback", origin).toString(),
    );
    url.searchParams.set(
      "state",
      createPluginGatewayState(
        { provider: "slack", userId: user.id, workspaceId: workspace.id },
        stateSecret,
      ),
    );
    installUrl = url.toString();
  }
  return {
    workspace,
    installationId: installation?.id ?? null,
    connected: Boolean(installation),
    installUrl,
    secure: origin.startsWith("https://"),
    configured: Boolean(stateSecret),
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
  if (text(form, "intent") !== "disconnect") return { error: "Unsupported action." };
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

export default function SlackAppPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <Link to="/admin">{t("Admin")}</Link>
            <span aria-hidden>›</span>
            <Link to="/plugins">{t("Plugins")}</Link>
            <span aria-hidden>›</span>
            <span>{t("Slack app")}</span>
          </nav>
        }
        title={t("Connect Señor Braino to Slack")}
      >
        <p className="text-xs text-muted-foreground">
          {t(
            "Install the official Señor Braino app. The Braino plugin gateway holds Slack credentials; this workspace receives only its own scoped connection.",
          )}
        </p>
      </PageHeader>

      {!data.secure ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t("Slack requires a public HTTPS address. Set DOCO_PUBLIC_HOST before connecting.")}
        </p>
      ) : null}
      {!data.configured ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t("The plugin secret key must be configured before connecting Slack.")}
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
            {data.connected ? t("Señor Braino is connected") : t("Install from Slack")}
          </CardTitle>
          <CardDescription>
            {data.connected
              ? t("Mention Señor Braino in a channel or send it a direct message.")
              : t("Slack will ask which workspace may install the official app, then return here.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.connected ? (
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
          ) : data.installUrl ? (
            <a
              href={data.installUrl}
              className="neu-button inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t("Add Señor Braino to Slack")}
            </a>
          ) : null}
        </CardContent>
      </Card>
    </PageMain>
  );
}
