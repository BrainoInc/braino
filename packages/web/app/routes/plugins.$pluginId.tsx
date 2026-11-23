import { withClient } from "@doco/db";
import {
  PluginInstallationError,
  connectWorkspaceEmailPlugin,
  listPluginInstallations,
  removePluginInstallation,
} from "@doco/host";
import {
  ModelPluginVerificationError,
  activateWorkspaceModelPlugin,
  installWorkspaceModelPlugin,
  verifyWorkspaceModelPlugin,
} from "@doco/host/model-plugins";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { PluginLogo } from "~/components/plugin-logo";
import { bundledModelPlugin, bundledPlugin } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import { MODEL_CAPABILITY } from "~/lib/model-plugin-catalog";
import { loadModelSetup, pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  type ModelPluginPageId,
  PLUGIN_MANIFEST_IDS,
  type PluginPageId,
  isModelPluginPage,
  modelKindForPlugin,
  pluginPageId,
} from "~/lib/plugin-catalog";
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

type Params = { pluginId?: string };

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function nameOf(id: PluginPageId): string {
  if (id === "openai-chat") return "OpenAI Chat";
  if (id === "openai-embedding") return "OpenAI Embeddings";
  if (id === "ollama-chat") return "Ollama Chat";
  if (id === "ollama-embedding") return "Ollama Embeddings";
  if (id === "slack") return "Slack";
  return "Resend";
}

async function pluginContext(request: Request, params: Params) {
  const id = pluginPageId(params.pluginId);
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
  return [{ title: t("Plugin · Braino") }];
}

export async function loader({ request, params }: { request: Request; params: Params }) {
  const { id, setup, installations } = await pluginContext(request, params);
  const saved = new URL(request.url).searchParams.get("saved") === "1";
  const manifestId = PLUGIN_MANIFEST_IDS[id];
  const matching = installations.filter((item) => item.manifest.id === manifestId);
  const enabled = matching.filter((item) => item.enabled);

  if (isModelPluginPage(id)) {
    const kind = modelKindForPlugin(id);
    const entry = setup.catalog.find((candidate) => candidate.id === manifestId);
    if (!entry) throw new Response("Plugin is not included in this deployment", { status: 404 });
    const installed = setup.installed.find((candidate) => candidate.pluginId === manifestId);
    return {
      type: "model" as const,
      id,
      workspace: setup.workspace,
      installed: Boolean(installed),
      active: installed?.active ?? false,
      verified: installed?.verified ?? false,
      installationId: installed?.installationId ?? null,
      ready: setup.ready,
      saved,
      setting: {
        kind,
        manifestId,
        model: installed?.configuration.model?.trim() || entry.defaultModel,
        suggestedModels: entry.suggestedModels,
        requiredSecrets: entry.requiredSecrets,
        storedSecrets: [...(installed?.secretNames ?? [])],
      },
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
      url.searchParams.set("callback_url", new URL("/plugins/slack/callback", origin).toString());
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

async function removePlugin(
  context: Awaited<ReturnType<typeof pluginContext>>,
  t: Awaited<ReturnType<typeof requestTranslator>>,
): Promise<Response | { error: string }> {
  const manifestId = PLUGIN_MANIFEST_IDS[context.id];
  for (const installation of context.installations) {
    if (installation.manifest.id !== manifestId) continue;
    try {
      await withClient((client) =>
        removePluginInstallation(client, {
          workspaceId: context.setup.workspace.id,
          userId: context.setup.userId,
          installationId: installation.id,
        }),
      );
    } catch (error) {
      if (error instanceof PluginInstallationError && error.code === "active_plugin_removal") {
        return { error: t("Make another plugin active before removing this one.") };
      }
      throw error;
    }
  }
  return redirect("/plugins?view=installed");
}

async function saveModelPlugin(
  id: ModelPluginPageId,
  context: Awaited<ReturnType<typeof pluginContext>>,
  form: FormData,
  t: Awaited<ReturnType<typeof requestTranslator>>,
) {
  const apiKey = text(form, "api_key");
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey)
    return { error: t("DOCO_ENCRYPTION_KEY must contain at least 32 characters.") };
  if (!host) return { error: t("The plugin service is not configured.") };

  try {
    const kind = modelKindForPlugin(id);
    const manifestId = PLUGIN_MANIFEST_IDS[id];
    const bundled = await bundledModelPlugin(manifestId);
    if (!bundled) return { error: t("This plugin is not included in this Braino image.") };
    const model = text(form, "model");
    if (!model) return { error: t("Choose a model.") };
    const installed = context.setup.installed.find((item) => item.pluginId === manifestId);
    const needsKey = bundled.entry.requiredSecrets.includes("api_key");
    if (needsKey && !apiKey && !installed?.secretNames.includes("api_key")) {
      return { error: t("Enter this plugin's OpenAI API key.") };
    }
    const installation = await withClient((client) =>
      installWorkspaceModelPlugin(client, {
        workspaceId: context.setup.workspace.id,
        userId: context.setup.userId,
        capability: MODEL_CAPABILITY[kind],
        plugin: {
          manifest: bundled.manifest,
          component: bundled.component,
          configuration: { model },
          ...(needsKey && apiKey ? { secrets: { api_key: apiKey }, encryptionKey } : {}),
        },
      }),
    );
    await withClient((client) =>
      verifyWorkspaceModelPlugin(client, {
        workspaceId: context.setup.workspace.id,
        installationId: installation.id,
        capability: MODEL_CAPABILITY[kind],
        encryptionKey,
        host,
      }),
    );
    const active = context.setup.installed.find(
      (candidate) => candidate.kind === kind && candidate.active,
    );
    if (!active || active.installationId === installation.id) {
      await withClient((client) =>
        activateWorkspaceModelPlugin(client, {
          workspaceId: context.setup.workspace.id,
          userId: context.setup.userId,
          capability: MODEL_CAPABILITY[kind],
          installationId: installation.id,
        }),
      );
    }
  } catch (error) {
    if (error instanceof ModelPluginVerificationError) {
      return {
        error:
          error.kind === "chat"
            ? t("Braino could not get an answer from this plugin. Check the model and connection.")
            : t("Braino could not search with this plugin. Check the model and connection."),
      };
    }
    if (error instanceof PluginInstallationError) {
      return { error: t("Braino could not install this plugin.") };
    }
    throw error;
  }
  return redirect(`/plugins/${id}?saved=1`);
}

async function activateModelPlugin(
  id: ModelPluginPageId,
  context: Awaited<ReturnType<typeof pluginContext>>,
  t: Awaited<ReturnType<typeof requestTranslator>>,
) {
  const kind = modelKindForPlugin(id);
  const manifestId = PLUGIN_MANIFEST_IDS[id];
  const installed = context.setup.installed.find((plugin) => plugin.pluginId === manifestId);
  if (!installed) return { error: t("Install and test this plugin before making it active.") };
  try {
    await withClient((client) =>
      activateWorkspaceModelPlugin(client, {
        workspaceId: context.setup.workspace.id,
        userId: context.setup.userId,
        capability: MODEL_CAPABILITY[kind],
        installationId: installed.installationId,
      }),
    );
  } catch (error) {
    if (error instanceof PluginInstallationError) {
      return { error: t("Install and test this plugin before making it active.") };
    }
    throw error;
  }
  return redirect(`/plugins/${id}?saved=1`);
}

export async function action({ request, params }: { request: Request; params: Params }) {
  const t = await requestTranslator(request);
  const context = await pluginContext(request, params);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: t(error.message) };
    throw error;
  }
  const intent = text(form, "intent");
  if (intent === "remove") return removePlugin(context, t);
  if (isModelPluginPage(context.id)) {
    if (intent === "activate") return activateModelPlugin(context.id, context, t);
    if (intent !== "save") return { error: t("Unsupported action.") };
    return saveModelPlugin(context.id, context, form, t);
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
  if (!encryptionKey || !host) return { error: t("The plugin service is not configured.") };
  const bundled = await bundledPlugin("braino.resend");
  if (!bundled) return { error: t("This plugin is not included in this Braino image.") };
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
    return { error: t("Braino could not install this plugin. Check the settings and try again.") };
  }
  return redirect("/plugins/resend?saved=1");
}

function PluginBreadcrumb({ name }: { name: string }) {
  const t = useT();
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/">{"Braino"}</Link>
      <span aria-hidden>›</span>
      <Link to="/admin">{t("Admin")}</Link>
      <span aria-hidden>›</span>
      <Link to="/plugins">{t("Plugins")}</Link>
      <span aria-hidden>›</span>
      <span>{name}</span>
    </nav>
  );
}

function RemovePluginForm({ label }: { label: string }) {
  const t = useT();
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="remove" />
      <button type="submit" className="neu-button rounded-md px-4 py-2 text-sm text-destructive">
        {t("Remove plugin")} · {label}
      </button>
    </Form>
  );
}

function ModelPluginPanel({
  data,
}: { data: Extract<Awaited<ReturnType<typeof loader>>, { type: "model" }> }) {
  const t = useT();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle";
  const needsApiKey = data.setting.requiredSecrets.includes("api_key");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{data.installed ? t("Plugin settings") : t("Install plugin")}</CardTitle>
        <CardDescription>
          {needsApiKey
            ? t("This plugin keeps its own API key. Other plugins cannot read or reuse it.")
            : t("This plugin uses the private Ollama service on this Braino server.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {data.saved ? (
          <output className="block rounded-md border border-primary p-3 text-sm">
            {t("The plugin is installed and working.")}{" "}
            <Link
              to={data.ready ? "/" : "/plugins"}
              className="font-semibold text-primary hover:underline"
            >
              {data.ready ? t("Continue to workspace") : t("Choose the next required plugin")}
            </Link>
          </output>
        ) : null}
        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <label className="block text-xs">
            <span className="mb-1 block font-semibold">
              {data.setting.kind === "chat" ? t("Chat model") : t("Embedding model")}
            </span>
            <span className="mb-2 block text-muted-foreground">
              {data.setting.kind === "chat"
                ? t("Answers questions and writes summaries.")
                : t("Finds records by meaning, not only matching words.")}
            </span>
            <input
              name="model"
              defaultValue={data.setting.model}
              list="plugin-models"
              required
              className="w-full rounded-md px-3 py-2 font-mono text-sm"
            />
            <datalist id="plugin-models">
              {data.setting.suggestedModels.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          </label>
          {needsApiKey ? (
            <label className="block text-xs">
              <span className="mb-1 block font-semibold">
                {data.setting.kind === "chat"
                  ? t("Chat plugin API key")
                  : t("Embedding plugin API key")}
              </span>
              <input
                name="api_key"
                type="password"
                autoComplete="off"
                required={!data.setting.storedSecrets.includes("api_key")}
                className="w-full rounded-md px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-muted-foreground">
                {data.setting.storedSecrets.includes("api_key")
                  ? t("A key is already stored. Leave this empty to keep it.")
                  : t("This key is encrypted for this plugin only and is never displayed again.")}
              </span>
            </label>
          ) : null}
          <button
            type="submit"
            disabled={saving}
            className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
          >
            {saving ? t("Testing…") : data.installed ? t("Save changes") : t("Install plugin")}
          </button>
        </Form>
        {data.installed && data.verified && !data.active ? (
          <Form method="post">
            <input type="hidden" name="intent" value="activate" />
            <button
              type="submit"
              disabled={saving}
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-60"
            >
              {t("Make active")}
            </button>
          </Form>
        ) : null}
        {data.installed && data.active ? (
          <p className="text-xs text-muted-foreground">
            {t("Make another plugin active before removing this one.")}
          </p>
        ) : null}
        {data.installed && !data.active ? <RemovePluginForm label={nameOf(data.id)} /> : null}
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
        <CardTitle>
          {data.installed ? t("Señor Braino is connected") : t("Install plugin")}
        </CardTitle>
        <CardDescription>
          {data.installed
            ? t("Mention Señor Braino in a channel or send it a direct message.")
            : t(
                "Slack will ask which workspace may install the official plugin, then return here.",
              )}
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
            {t("The plugin secret key must be configured before connecting Slack.")}
          </p>
        ) : null}
        {data.installed ? (
          <RemovePluginForm label={"Slack"} />
        ) : data.installUrl ? (
          <a
            href={data.installUrl}
            className="neu-button inline-flex rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
          >
            {t("Install plugin")}
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
        <CardTitle>{data.installed ? t("Plugin settings") : t("Install plugin")}</CardTitle>
        <CardDescription>
          {t("Connect your Resend account and verify it with one test email.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.configured ? (
          <p role="alert" className="text-sm text-destructive">
            {t("The plugin service must be configured before connecting Resend.")}
          </p>
        ) : null}
        {data.installed ? (
          <div className="space-y-4">
            <p className="text-sm">
              <span className="text-muted-foreground">{t("Sender")}: </span>
              <span className="font-mono">{data.sender}</span>
            </p>
            <RemovePluginForm label={"Resend"} />
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
                {saving ? t("Testing…") : t("Install plugin")}
              </button>
            </div>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

export default function PluginPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData() as { error?: string } | undefined;
  const name = nameOf(data.id);
  const description =
    data.type === "model"
      ? data.setting.kind === "chat"
        ? t("Configure one plugin for Braino answers and summaries.")
        : t("Configure one plugin for semantic search and indexing.")
      : data.type === "slack"
        ? t("Connect Señor Braino to your team's Slack workspace.")
        : t("Send Braino email through your Resend account.");
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={<PluginBreadcrumb name={name} />}
        title={
          <span className="inline-flex items-center gap-3">
            <PluginLogo pluginId={data.id} />
            <span>{name}</span>
          </span>
        }
      >
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
      {data.type === "model" ? (
        <ModelPluginPanel data={data} />
      ) : data.type === "slack" ? (
        <SlackPanel data={data} />
      ) : (
        <ResendPanel data={data} />
      )}
    </PageMain>
  );
}
