import { withClient } from "@doco/db";
import { PluginInstallationError, assignWorkspaceModelPlugin } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { CircleDollarSign, FileText, Globe } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card } from "~/components/card";
import {
  BackLink,
  ModelSetupBreadcrumb,
  modelTitle,
  pluginTagline,
  publishedByBraino,
} from "~/components/model-setup";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { bundledModelPlugin } from "~/lib/bundled-model-plugins.server";
import {
  MODEL_CAPABILITY,
  type ModelKind,
  type ModelPluginEntry,
  modelKind,
} from "~/lib/model-plugin-catalog";
import { loadModelSetup, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

/** The picker value that reveals the free-text model field. */
const ANOTHER_MODEL = "__another";

interface LoaderData {
  kind: ModelKind;
  firstRun: boolean;
  plugin: ModelPluginEntry;
  model: string;
  /** Secrets this plugin already holds; their values never leave the server. */
  storedSecrets: string[];
  /** The plugin this one would take the model over from. */
  replaces: string | null;
}

type Params = { model?: string; pluginId?: string };

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Model setup · Braino") }];
}

/** The owner's setup state and the bundled plugin this page is about. */
async function pluginPage(request: Request, params: Params) {
  const kind = modelKind(params.model);
  if (!kind) throw new Response("Not found", { status: 404 });
  const setup = await loadModelSetup(request);
  if (!setup.isOwner) throw redirect("/admin/models");
  const bundled = params.pluginId ? await bundledModelPlugin(params.pluginId) : null;
  if (!bundled || bundled.entry.kind !== kind) throw new Response("Not found", { status: 404 });
  const installed = setup.installed.find(
    (plugin) => plugin.pluginId === bundled.entry.id && plugin.kind === kind,
  );
  return { kind, setup, bundled, installed };
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: Params;
}): Promise<LoaderData> {
  const { kind, setup, bundled, installed } = await pluginPage(request, params);
  const step = setup.steps.find((candidate) => candidate.kind === kind);
  return {
    kind,
    firstRun: !setup.ready,
    plugin: bundled.entry,
    model: installed?.configuration.model?.trim() || bundled.entry.defaultModel,
    storedSecrets: [...(installed?.secretNames ?? [])],
    replaces:
      step?.pluginId && step.pluginId !== bundled.entry.id && step.status !== "preselected"
        ? step.pluginName
        : null,
  };
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** "Use this plugin": assigns this one plugin, with its own model and key, to this one model. */
export async function action({ request, params }: { request: Request; params: Params }) {
  const t = await requestTranslator(request);
  const { kind, setup, bundled, installed } = await pluginPage(request, params);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: t(error.message) };
    throw error;
  }
  const choice = text(form, "model");
  const model = choice === ANOTHER_MODEL ? text(form, "model_other") : choice;
  if (!model) return { error: t("Enter a model name.") };
  const configuration: Record<string, string> = { model };
  const secrets: Record<string, string> = {};
  for (const name of bundled.entry.requiredSecrets) {
    const value = text(form, `secret_${name}`);
    if (value) secrets[name] = value;
    else if (!installed?.secretNames.includes(name)) {
      return { error: t("Enter this plugin's key.") };
    }
  }
  const sealing: { secrets?: Record<string, string>; encryptionKey?: string } = {};
  if (Object.keys(secrets).length > 0) {
    const encryptionKey = pluginSecretsKey();
    if (!encryptionKey) {
      return { error: t("DOCO_ENCRYPTION_KEY must contain at least 32 characters.") };
    }
    sealing.secrets = secrets;
    sealing.encryptionKey = encryptionKey;
  }
  try {
    await withClient((client) =>
      assignWorkspaceModelPlugin(client, {
        workspaceId: setup.workspace.id,
        userId: setup.userId,
        capability: MODEL_CAPABILITY[kind],
        plugin: {
          manifest: bundled.manifest,
          component: bundled.component,
          configuration,
          ...sealing,
        },
      }),
    );
  } catch (error) {
    if (error instanceof PluginInstallationError) return { error: t(error.message) };
    throw error;
  }
  return redirect("/admin/models");
}

function Capability({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 border-t border-border py-2.5 text-sm">
      <span aria-hidden className="mt-0.5 shrink-0 text-muted-foreground">
        {icon}
      </span>
      <span className="min-w-0 break-words">{children}</span>
    </li>
  );
}

export default function ModelPluginPage() {
  const t = useT();
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as { error?: string } | undefined;
  const { plugin, kind } = data;
  const suggested = plugin.suggestedModels.includes(data.model);
  const [choice, setChoice] = useState(suggested ? data.model : ANOTHER_MODEL);
  const hosts = plugin.networkHosts.join(", ");
  const pluginsPath = `/admin/models/${kind}`;
  return (
    <PageMain className="py-6">
      <div className="max-w-3xl space-y-5">
        <div className="space-y-3.5">
          <PageHeader
            breadcrumb={
              <ModelSetupBreadcrumb
                firstRun={data.firstRun}
                trail={[{ label: modelTitle(t, kind), to: pluginsPath }, { label: plugin.name }]}
              />
            }
            title={plugin.name}
          >
            <p className="text-xs text-muted-foreground">
              {publishedByBraino(plugin) ? `${t("By Braino")} · ` : null}
              {pluginTagline(t, plugin)}
            </p>
          </PageHeader>
          <BackLink to={pluginsPath}>
            {kind === "chat" ? t("Chat model plugins") : t("Embedding model plugins")}
          </BackLink>
        </div>

        <Card className="p-5">
          <h2 className="mb-1.5 font-mono text-[11px] text-muted-foreground">
            {t("What this plugin can do")}
          </h2>
          <ul>
            <Capability icon={<Globe className="size-[18px]" />}>
              {hosts
                ? t.rich("Connect to <host>{hosts}</host> and nowhere else", {
                    host: (children) => <span className="font-mono">{children}</span>,
                    hosts,
                  })
                : t("Connect to nothing outside Braino")}
            </Capability>
            <Capability icon={<FileText className="size-[18px]" />}>
              {plugin.local
                ? t("Read the questions and record text Braino gives it. They stay on this server")
                : t("Send the questions and record text Braino gives it to {hosts}", { hosts })}
            </Capability>
            {plugin.local || plugin.requiredSecrets.length > 0 ? (
              <Capability icon={<CircleDollarSign className="size-[18px]" />}>
                {plugin.local
                  ? t("No usage fees. It uses this server's memory and processor")
                  : t("Usage is billed to the account its key belongs to")}
              </Capability>
            ) : null}
          </ul>

          <Form method="post" className="mt-4 space-y-3.5">
            <div>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{modelTitle(t, kind)}</span>
                <select
                  name="model"
                  value={choice}
                  onChange={(event) => setChoice(event.target.value)}
                  className="w-full rounded-md px-3 py-2 font-mono text-sm text-foreground"
                >
                  {plugin.suggestedModels.map((model, index) => (
                    <option key={model} value={model}>
                      {index === 0 ? t("{model} (recommended)", { model }) : model}
                    </option>
                  ))}
                  <option value={ANOTHER_MODEL}>{t("Another model…")}</option>
                </select>
              </label>
              {choice === ANOTHER_MODEL ? (
                <input
                  name="model_other"
                  aria-label={t("Model name")}
                  defaultValue={suggested ? "" : data.model}
                  placeholder={
                    plugin.local
                      ? t("Any model this server can run")
                      : t("Any model this plugin's key can use")
                  }
                  required
                  className="mt-2 w-full rounded-md px-3 py-2 font-mono text-sm text-foreground"
                />
              ) : null}
              {data.replaces ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {t("Replaces {plugin}.", { plugin: data.replaces })}
                </p>
              ) : null}
            </div>

            {plugin.requiredSecrets.map((name) => {
              const stored = data.storedSecrets.includes(name);
              return (
                <div key={name}>
                  <label className="block text-xs">
                    <span className="mb-1 block text-muted-foreground">
                      {name === "api_key"
                        ? t("{plugin} key", { plugin: plugin.name })
                        : t("{plugin} secret {name}", { plugin: plugin.name, name })}
                    </span>
                    <input
                      name={`secret_${name}`}
                      type="password"
                      autoComplete="off"
                      required={!stored}
                      className="w-full rounded-md px-3 py-2 text-sm text-foreground"
                    />
                  </label>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {stored
                      ? t(
                          "This plugin already holds its own key. Leave this empty to keep it, or enter a new one to replace it.",
                        )
                      : t(
                          "This plugin keeps its own key. Braino stores it encrypted and never displays it.",
                        )}
                  </p>
                </div>
              );
            })}

            {plugin.local ? (
              <p className="neu-well rounded-md bg-input px-3 py-2 text-xs">
                {t(
                  "Ollama starts with Braino and downloads the default models automatically. Any other model must already be on this server.",
                )}
              </p>
            ) : null}

            {actionData?.error ? (
              <p role="alert" className="text-xs text-destructive">
                {actionData.error}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-3 pt-1">
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {t("Use this plugin")}
              </button>
              <Link
                to={pluginsPath}
                className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
              >
                {t("Cancel")}
              </Link>
            </div>
          </Form>
        </Card>
      </div>
    </PageMain>
  );
}
