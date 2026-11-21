import { withClient } from "@doco/db";
import {
  connectWorkspaceEmailPlugin,
  getSingleWorkspaceState,
  getWorkspaceRole,
  listPluginInstallations,
  setPluginInstallationEnabled,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
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

const RESEND_PLUGIN_ID = "braino.resend";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function emailContext(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const role = await withClient((client) => getWorkspaceRole(client, state.workspace.id, user.id));
  if (role !== "owner") throw new Response("Owner access required", { status: 403 });
  return { user, workspace: state.workspace };
}

export async function loader({ request }: { request: Request }) {
  const { user, workspace } = await emailContext(request);
  const installations = await withClient((client) =>
    listPluginInstallations(client, { workspaceId: workspace.id, userId: user.id }),
  );
  const installation = installations.find(
    (candidate) => candidate.enabled && candidate.manifest.capabilities["email.send"] === 1,
  );
  return {
    workspace,
    connected: Boolean(installation),
    installationId: installation?.id ?? null,
    providerName: installation?.manifest.name ?? null,
    sender: installation?.configuration.sender ?? "",
    configured: Boolean(pluginSecretsKey() && pluginHostConnection()),
    ownerEmail: user.email,
  };
}

export async function action({ request }: { request: Request }) {
  const { user, workspace } = await emailContext(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: error.message };
    throw error;
  }
  const intent = text(form, "intent");
  if (intent === "disconnect") {
    await withClient((client) =>
      setPluginInstallationEnabled(client, {
        workspaceId: workspace.id,
        userId: user.id,
        installationId: text(form, "installation_id"),
        enabled: false,
      }),
    );
    return redirect("/integrations/email?disconnected=1");
  }
  if (intent !== "connect") return { error: "Unsupported action." };

  const sender = text(form, "sender");
  const apiKey = text(form, "api_key");
  const verificationRecipient = text(form, "verification_recipient");
  if (!sender || !apiKey || !verificationRecipient) {
    return { error: "Sender, API key, and verification recipient are required." };
  }
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) {
    return { error: "The plugin service must be configured before connecting email." };
  }
  const bundled = await bundledPlugin(RESEND_PLUGIN_ID);
  if (!bundled) return { error: "The Resend plugin is not included in this Braino image." };
  try {
    await withClient((client) =>
      connectWorkspaceEmailPlugin(client, {
        workspaceId: workspace.id,
        userId: user.id,
        manifest: bundled.manifest,
        component: bundled.component,
        configuration: { sender },
        secrets: { api_key: apiKey },
        encryptionKey,
        host,
        verificationRecipient,
      }),
    );
    return redirect("/integrations/email?connected=1");
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not connect the email provider.",
    };
  }
}

export default function EmailPluginPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  const connecting =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "connect";

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
            <span>{t("Email")}</span>
          </nav>
        }
        title={t("Email provider")}
      >
        <p className="text-xs text-muted-foreground">
          {t(
            "Install one email plugin for this workspace. Braino uses the shared email contract; the provider keeps its own API key and sender settings.",
          )}
        </p>
      </PageHeader>

      {!data.configured ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {t("The plugin host and encryption key must be configured before connecting email.")}
        </p>
      ) : null}
      {actionData?.error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionData.error}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{data.connected ? data.providerName : t("Resend")}</CardTitle>
          <CardDescription>
            {data.connected
              ? t(
                  "Email is ready for this workspace. The API key remains encrypted and is never shown.",
                )
              : t(
                  "Use your own Resend account. Connecting sends one verification email before saving the plugin.",
                )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.connected ? (
            <div className="space-y-4">
              <p className="text-sm">
                <span className="text-muted-foreground">{t("Sender")}: </span>
                <span className="font-mono">{data.sender}</span>
              </p>
              <Form method="post">
                <input type="hidden" name="intent" value="disconnect" />
                <input type="hidden" name="installation_id" value={data.installationId ?? ""} />
                <button
                  type="submit"
                  className="neu-button rounded-md px-4 py-2 text-sm text-destructive"
                >
                  {t("Disconnect email provider")}
                </button>
              </Form>
            </div>
          ) : (
            <Form method="post" className="grid gap-4 sm:grid-cols-2">
              <input type="hidden" name="intent" value="connect" />
              <label className="text-xs sm:col-span-2">
                <span className="mb-1 block text-muted-foreground">{t("Sender")}</span>
                <input
                  name="sender"
                  required
                  placeholder={"Braino <hello@example.com>"}
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-muted-foreground">
                  {t("Use an address from a domain you verified in Resend.")}
                </span>
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Resend API key")}</span>
                <input
                  name="api_key"
                  type="password"
                  required
                  autoComplete="new-password"
                  placeholder={"re_…"}
                  className="w-full rounded-md px-3 py-2 font-mono text-sm"
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Send test to")}</span>
                <input
                  name="verification_recipient"
                  type="email"
                  required
                  defaultValue={data.ownerEmail}
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <div className="sm:col-span-2 sm:text-end">
                <button
                  type="submit"
                  disabled={connecting || !data.configured}
                  className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
                >
                  {connecting ? t("Connecting…") : t("Connect and send test email")}
                </button>
              </div>
            </Form>
          )}
        </CardContent>
      </Card>
    </PageMain>
  );
}
