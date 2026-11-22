import { withClient } from "@doco/db";
import {
  ModelPluginVerificationError,
  PluginInstallationError,
  type WorkspaceModelPluginAssignment,
  assignWorkspaceModelPlugins,
  connectWorkspaceEmailPlugin,
  listPluginInstallations,
  removePluginInstallation,
  verifyWorkspaceModelPlugins,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import {
  APP_PLUGIN_IDS,
  type AiAppId,
  type AppId,
  appId,
  isAiApp,
  modelPluginId,
} from "~/lib/app-catalog";
import { bundledModelPlugin, bundledPlugin } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import { MODEL_CAPABILITY, MODEL_KINDS, type ModelKind } from "~/lib/model-plugin-catalog";
import { loadModelSetup, pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  brainoPluginGatewayUrl,
  createPluginGatewayState,
} from "~/lib/plugin-gateway-state.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

type Params = { appId?: string };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nameOf(id: AppId): string {
  if (id === "openai") return "OpenAI";
  if (id === "ollama") return "Ollama";
  if (id === "slack") return "Slack";
  return "Resend";
}

async function appContext(request: Request, params: Params) {
  const id = appId(params.appId);
  if (!id) throw new Response("Not found", { status: 404 });
  const setup = await loadModelSetup(request);
  if (!setup.isOwner) throw new Response("Owner access required", { status: 403 });
  const installations = await withClient((client) =>
    listPluginInstallations(client, {
      workspaceId: setup.workspace.id,
      userId: setup.userId,
    }),
  );
  return { id, setup, installations };
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("App · Braino") }];
}

export async function loader({ request, params }: { request: Request; params: Params }) {
  const { id, setup, installations } = await appContext(request, params);
  const saved = new URL(request.url).searchParams.get("saved") === "1";
  const pluginIds = APP_PLUGIN_IDS[id] as readonly string[];
  const matching = installations.filter((item) => pluginIds.includes(item.manifest.id));
  const enabled = matching.filter((item) => item.enabled);

  if (isAiApp(id)) {
    const settings = MODEL_KINDS.map((kind) => {
      const pluginId = modelPluginId(id, kind);
      const entry = setup.catalog.find((candidate) => candidate.id === pluginId);
      if (!entry) throw new Response("App is not included in this deployment", { status: 404 });
      const installed = setup.installed.find((candidate) => candidate.pluginId === pluginId);
      return {
        kind,
        pluginId,
        model: installed?.configuration.model?.trim() || entry.defaultModel,
        suggestedModels: entry.suggestedModels,
        requiredSecrets: entry.requiredSecrets,
        storedSecrets: [...(installed?.secretNames ?? [])],
      };
    });
    return {
      type: "ai" as const,
      id,
      workspace: setup.workspace,
      installed: enabled.length > 0,
      active: pluginIds.every((pluginId) =>
        setup.steps.some((step) => step.pluginId === pluginId && step.status !== "preselected"),
      ),
      ready: setup.ready,
      saved,
      settings,
    };
  }

  if (id === "slack") {
    const origin = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
      /\/+$/,
      "",
    );
    const stateSecret = pluginSecretsKey();
    let installUrl: string | null = null;
    if (enabled.length === 0 && stateSecret && origin.startsWith("https://")) {
      const url = new URL("/v1/providers/slack/install", brainoPluginGatewayUrl());
      url.searchParams.set("callback_url", new URL("/apps/slack/callback", origin).toString());
      url.searchParams.set(
        "state",
        createPluginGatewayState(
          { provider: "slack", userId: setup.userId, workspaceId: setup.workspace.id },
          stateSecret,
        ),
      );
      installUrl = url.toString();
    }
    return {
      type: "slack" as const,
      id,
      workspace: setup.workspace,
      installed: enabled.length > 0,
      installationId: enabled[0]?.id ?? null,
      installUrl,
      secure: origin.startsWith("https://"),
      configured: Boolean(stateSecret),
    };
  }

  const user = await getCurrentUser(request);
  return {
    type: "resend" as const,
    id,
    workspace: setup.workspace,
    installed: enabled.length > 0,
    installationId: enabled[0]?.id ?? null,
    sender: enabled[0]?.configuration.sender ?? "",
    configured: Boolean(pluginSecretsKey() && pluginHostConnection()),
    ownerEmail: user?.email ?? "",
  };
}

async function removeApp(context: Awaited<ReturnType<typeof appContext>>): Promise<Response> {
  const ids = APP_PLUGIN_IDS[context.id] as readonly string[];
  for (const installation of context.installations) {
    if (!installation.enabled || !ids.includes(installation.manifest.id)) continue;
    await withClient((client) =>
      removePluginInstallation(client, {
        workspaceId: context.setup.workspace.id,
        userId: context.setup.userId,
        installationId: installation.id,
      }),
    );
  }
  return redirect("/apps?view=installed");
}

async function saveAiApp(
  id: AiAppId,
  context: Awaited<ReturnType<typeof appContext>>,
  form: FormData,
  t: Awaited<ReturnType<typeof requestTranslator>>,
) {
  const apiKey = text(form, "api_key");
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey)
    return { error: t("DOCO_ENCRYPTION_KEY must contain at least 32 characters.") };
  if (!host) return { error: t("The app service is not configured.") };

  try {
    const plugins: WorkspaceModelPluginAssignment[] = [];
    for (const kind of MODEL_KINDS) {
      const pluginId = modelPluginId(id, kind);
      const bundled = await bundledModelPlugin(pluginId);
      if (!bundled) return { error: t("This app is not included in this Braino image.") };
      const model = text(form, `${kind}_model`);
      if (!model) return { error: t("Choose a model for chat and search.") };
      const installed = context.setup.installed.find((item) => item.pluginId === pluginId);
      const needsKey = bundled.entry.requiredSecrets.includes("api_key");
      if (needsKey && !apiKey && !installed?.secretNames.includes("api_key")) {
        return { error: t("Enter your OpenAI API key.") };
      }
      plugins.push({
        capability: MODEL_CAPABILITY[kind],
        plugin: {
          manifest: bundled.manifest,
          component: bundled.component,
          configuration: { model },
          ...(needsKey && apiKey ? { secrets: { api_key: apiKey }, encryptionKey } : {}),
        },
      });
    }
    await withClient((client) =>
      assignWorkspaceModelPlugins(client, {
        workspaceId: context.setup.workspace.id,
        userId: context.setup.userId,
        plugins,
      }),
    );
    await withClient((client) =>
      verifyWorkspaceModelPlugins(client, {
        workspaceId: context.setup.workspace.id,
        encryptionKey,
        host,
      }),
    );
  } catch (error) {
    if (error instanceof ModelPluginVerificationError) {
      return {
        error:
          error.kind === "chat"
            ? t(
                "Braino could not get an answer from this app. Check the chat model and connection.",
              )
            : t("Braino could not search with this app. Check the search model and connection."),
      };
    }
    if (error instanceof PluginInstallationError) {
      return { error: t("Braino could not install this app.") };
    }
    throw error;
  }
  return redirect(`/apps/${id}?saved=1`);
}

export async function action({ request, params }: { request: Request; params: Params }) {
  const t = await requestTranslator(request);
  const context = await appContext(request, params);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: t(error.message) };
    throw error;
  }
  const intent = text(form, "intent");
  if (intent === "remove") return removeApp(context);
  if (isAiApp(context.id)) {
    if (intent !== "save") return { error: t("Unsupported action.") };
    return saveAiApp(context.id, context, form, t);
  }
  if (context.id === "slack") return { error: t("Unsupported action.") };
  if (intent !== "connect") return { error: t("Unsupported action.") };

  const sender = text(form, "sender");
  const apiKey = text(form, "api_key");
  const verificationRecipient = text(form, "verification_recipient");
  if (!sender || !apiKey || !verificationRecipient) {
    return { error: t("Sender, API key, and test recipient are required.") };
  }
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) return { error: t("The app service is not configured.") };
  const bundled = await bundledPlugin("braino.resend");
  if (!bundled) return { error: t("This app is not included in this Braino image.") };
  try {
    await withClient((client) =>
      connectWorkspaceEmailPlugin(client, {
        workspaceId: context.setup.workspace.id,
        userId: context.setup.userId,
        manifest: bundled.manifest,
        component: bundled.component,
        configuration: { sender },
        secrets: { api_key: apiKey },
        encryptionKey,
        host,
        verificationRecipient,
      }),
    );
  } catch {
    return { error: t("Braino could not install this app. Check the settings and try again.") };
  }
  return redirect("/apps/resend?saved=1");
}

function AppBreadcrumb({ name }: { name: string }) {
  const t = useT();
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/">{"Braino"}</Link>
      <span aria-hidden>›</span>
      <Link to="/admin">{t("Admin")}</Link>
      <span aria-hidden>›</span>
      <Link to="/apps">{t("Apps")}</Link>
      <span aria-hidden>›</span>
      <span>{name}</span>
    </nav>
  );
}

function RemoveAppForm({ label }: { label: string }) {
  const t = useT();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="remove" />
      <button type="submit" className="neu-button rounded-md px-4 py-2 text-sm text-destructive">
        {t("Remove app")} · {label}
      </button>
    </Form>
  );
}

function AiAppPanel({
  data,
}: { data: Extract<Awaited<ReturnType<typeof loader>>, { type: "ai" }> }) {
  const t = useT();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle";
  const openai = data.id === "openai";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.active ? t("App settings") : t("Install app")}</CardTitle>
        <CardDescription>
          {openai
            ? t("One OpenAI key powers both Braino answers and semantic search.")
            : t("Ollama runs both capabilities privately on this Braino server.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {data.saved ? (
          <output className="block rounded-md border border-primary p-3 text-sm">
            {t("The app is installed and working.")}{" "}
            <Link to="/" className="font-semibold text-primary hover:underline">
              {t("Continue to workspace")}
            </Link>
          </output>
        ) : null}
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          {data.settings.map((setting) => (
            <label key={setting.kind} className="block text-xs">
              <span className="mb-1 block font-semibold">
                {setting.kind === "chat" ? t("Chat responses") : t("Semantic search")}
              </span>
              <span className="mb-2 block text-muted-foreground">
                {setting.kind === "chat"
                  ? t("The model that answers questions and writes summaries.")
                  : t("The model that helps search find meaning, not only matching words.")}
              </span>
              <input
                name={`${setting.kind}_model`}
                defaultValue={setting.model}
                list={`${setting.kind}-models`}
                required
                className="w-full rounded-md px-3 py-2 font-mono text-sm"
              />
              <datalist id={`${setting.kind}-models`}>
                {setting.suggestedModels.map((model) => (
                  <option key={model} value={model} />
                ))}
              </datalist>
            </label>
          ))}
          {openai ? (
            <label className="block text-xs">
              <span className="mb-1 block font-semibold">{"OpenAI API key"}</span>
              <input
                name="api_key"
                type="password"
                autoComplete="off"
                required={data.settings.some(
                  (setting) =>
                    setting.requiredSecrets.includes("api_key") &&
                    !setting.storedSecrets.includes("api_key"),
                )}
                className="w-full rounded-md px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-muted-foreground">
                {data.settings.every((setting) => setting.storedSecrets.includes("api_key"))
                  ? t("A key is already stored. Leave this empty to keep it.")
                  : t("The key is encrypted and never displayed after you save it.")}
              </span>
            </label>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {saving ? t("Testing…") : data.active ? t("Save changes") : t("Install app")}
          </button>
        </Form>
        {data.installed ? <RemoveAppForm label={nameOf(data.id)} /> : null}
      </CardContent>
    </Card>
  );
}

function SlackPanel({
  data,
}: { data: Extract<Awaited<ReturnType<typeof loader>>, { type: "slack" }> }) {
  const t = useT();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.installed ? t("Señor Braino is connected") : t("Install app")}</CardTitle>
        <CardDescription>
          {data.installed
            ? t("Mention Señor Braino in a channel or send it a direct message.")
            : t("Slack will ask which workspace may install the official app, then return here.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.secure ? (
          <p role="alert" className="text-sm text-destructive">
            {t("Slack requires a public HTTPS address.")}
          </p>
        ) : null}
        {!data.configured ? (
          <p role="alert" className="text-sm text-destructive">
            {t("The app secret key must be configured before connecting Slack.")}
          </p>
        ) : null}
        {data.installed ? (
          <RemoveAppForm label={"Slack"} />
        ) : data.installUrl ? (
          <a
            href={data.installUrl}
            className="neu-button inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {t("Install app")}
          </a>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ResendPanel({
  data,
}: { data: Extract<Awaited<ReturnType<typeof loader>>, { type: "resend" }> }) {
  const t = useT();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.installed ? t("App settings") : t("Install app")}</CardTitle>
        <CardDescription>
          {t("Connect your Resend account and verify it with one test email.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.configured ? (
          <p role="alert" className="text-sm text-destructive">
            {t("The app service must be configured before connecting Resend.")}
          </p>
        ) : null}
        {data.installed ? (
          <div className="space-y-4">
            <p className="text-sm">
              <span className="text-muted-foreground">{t("Sender")}: </span>
              <span className="font-mono">{data.sender}</span>
            </p>
            <RemoveAppForm label={"Resend"} />
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
            </label>
            <label className="text-xs">
              <span className="mb-1 block text-muted-foreground">{t("Resend API key")}</span>
              <input
                name="api_key"
                type="password"
                required
                autoComplete="off"
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
                disabled={saving || !data.configured}
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
              >
                {saving ? t("Testing…") : t("Install app")}
              </button>
            </div>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

export default function AppPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as { error?: string } | undefined;
  const name = nameOf(data.id);
  const description =
    data.type === "ai"
      ? data.id === "openai"
        ? t("Use OpenAI for Braino answers and semantic search.")
        : t("Run Braino answers and semantic search privately with Ollama.")
      : data.type === "slack"
        ? t("Connect Señor Braino to your team's Slack workspace.")
        : t("Send Braino email through your Resend account.");
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader breadcrumb={<AppBreadcrumb name={name} />} title={name}>
        <p className="text-xs text-muted-foreground">{description}</p>
      </PageHeader>
      {actionData?.error ? (
        <p
          role="alert"
          className="rounded-md border border-destructive p-3 text-sm text-destructive"
        >
          {actionData.error}
        </p>
      ) : null}
      {data.type === "ai" ? (
        <AiAppPanel data={data} />
      ) : data.type === "slack" ? (
        <SlackPanel data={data} />
      ) : (
        <ResendPanel data={data} />
      )}
    </PageMain>
  );
}
