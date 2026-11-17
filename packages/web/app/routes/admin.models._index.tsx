import { withClient } from "@doco/db";
import {
  ModelPluginVerificationError,
  PluginInstallationError,
  assignWorkspaceModelPlugin,
  getWorkspaceModelPluginReadiness,
  verifyWorkspaceModelPlugins,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card } from "~/components/card";
import { ModelSetupBreadcrumb, StatusLine, modelTitle } from "~/components/model-setup";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { bundledModelPlugin } from "~/lib/bundled-model-plugins.server";
import { MODEL_CAPABILITY, type ModelStep } from "~/lib/model-plugin-catalog";
import { loadModelSetup, pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

interface LoaderData {
  isOwner: boolean;
  ready: boolean;
  steps: ModelStep[];
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Model setup · Braino") }];
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const setup = await loadModelSetup(request);
  return { isOwner: setup.isOwner, ready: setup.ready, steps: setup.steps };
}

/**
 * "Check and finish": installs whatever is still only pre-selected, then lets
 * the owner into the app once both models are ready.
 */
export async function action({ request }: { request: Request }) {
  const t = await requestTranslator(request);
  const setup = await loadModelSetup(request);
  if (!setup.isOwner) return { error: t("Only a workspace owner can set up models.") };
  try {
    await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: t(error.message) };
    throw error;
  }
  try {
    for (const step of setup.steps) {
      if (step.status !== "preselected" || !step.pluginId) continue;
      const bundled = await bundledModelPlugin(step.pluginId);
      if (!bundled) continue;
      await withClient((client) =>
        assignWorkspaceModelPlugin(client, {
          workspaceId: setup.workspace.id,
          userId: setup.userId,
          capability: MODEL_CAPABILITY[step.kind],
          plugin: {
            manifest: bundled.manifest,
            component: bundled.component,
            configuration: { model: bundled.entry.defaultModel },
          },
        }),
      );
    }
  } catch (error) {
    if (error instanceof PluginInstallationError) return { error: t(error.message) };
    throw error;
  }
  let readiness = await withClient((client) =>
    getWorkspaceModelPluginReadiness(client, setup.workspace.id),
  );
  const configured = (status: (typeof readiness)["chat"]) =>
    status === "ready" || status === "unverified";
  if (!configured(readiness.chat) && !configured(readiness.embedding)) {
    return { error: t("Configure the chat model and the embedding model first.") };
  }
  if (!configured(readiness.chat)) return { error: t("Configure the chat model first.") };
  if (!configured(readiness.embedding)) return { error: t("Configure the embedding model first.") };

  const encryptionKey = pluginSecretsKey();
  if (!encryptionKey) {
    return { error: t("DOCO_ENCRYPTION_KEY must contain at least 32 characters.") };
  }
  const host = pluginHostConnection();
  if (!host) return { error: t("The plugin service is not configured.") };
  try {
    await withClient((client) =>
      verifyWorkspaceModelPlugins(client, {
        workspaceId: setup.workspace.id,
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
                "The chat model could not answer. Check its model and key. For Ollama, check that the model has finished downloading.",
              )
            : t(
                "The embedding model could not answer. Check its model and key. For Ollama, check that the model has finished downloading.",
              ),
      };
    }
    throw error;
  }
  readiness = await withClient((client) =>
    getWorkspaceModelPluginReadiness(client, setup.workspace.id),
  );
  return readiness.ready
    ? redirect("/")
    : { error: t("Braino could not verify both model plugins. Try again.") };
}

function StepStatus({ step }: { step: ModelStep }) {
  const t = useT();
  if (step.status === "ready") {
    return (
      <StatusLine ok>
        {step.usesOwnKey ? t("Ready. It uses its own stored key.") : t("Ready.")}
      </StatusLine>
    );
  }
  if (step.status === "preselected") {
    return (
      <StatusLine ok>{t("Pre-selected. Check and finish installs it with this model.")}</StatusLine>
    );
  }
  if (step.status === "unverified") {
    return <StatusLine ok>{t("Installed. Check and finish will test this model.")}</StatusLine>;
  }
  if (step.status === "ambiguous") {
    return (
      <StatusLine ok={false}>
        {t("More than one plugin is enabled for this model. Configure it to choose one.")}
      </StatusLine>
    );
  }
  if (step.status === "invalid") {
    return (
      <StatusLine ok={false}>
        {t("This plugin's settings are incomplete. Configure it again.")}
      </StatusLine>
    );
  }
  return <StatusLine ok={false}>{t("Not configured yet.")}</StatusLine>;
}

export default function ModelSetupPage() {
  const t = useT();
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  const testing = navigation.state === "submitting";
  return (
    <PageMain className="py-6">
      <div className="max-w-3xl space-y-6">
        <PageHeader
          breadcrumb={<ModelSetupBreadcrumb firstRun={!data.ready} />}
          title={t("Set up your models")}
        >
          <p className="text-xs text-muted-foreground">
            {t(
              "Braino needs two models before it opens. Each one comes from a plugin. Keep the defaults, or configure either one.",
            )}
          </p>
        </PageHeader>

        <section className="space-y-3" aria-labelledby="model-steps-title">
          <h2 id="model-steps-title" className="font-mono text-[11px] text-muted-foreground">
            {t("What Braino needs")}
          </h2>
          <ol className="space-y-4">
            {data.steps.map((step, index) => (
              <li key={step.kind}>
                <Card className="space-y-3 px-5 py-4">
                  <div className="flex flex-wrap items-start gap-x-3.5 gap-y-3">
                    <div
                      aria-hidden
                      className="neu-well flex size-9 items-center justify-center rounded-md bg-input font-mono text-base font-bold text-primary"
                    >
                      {index + 1}
                    </div>
                    <div className="min-w-0 flex-[1_1_16rem]">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-base font-semibold">{modelTitle(t, step.kind)}</h3>
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {t("required")}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {step.kind === "chat"
                          ? t("Writes answers, summaries, and the links between records.")
                          : t(
                              "Turns records into numbers so search finds meaning, not only matching words.",
                            )}
                      </p>
                    </div>
                    {data.isOwner ? (
                      <Link
                        to={`/admin/models/${step.kind}`}
                        aria-label={
                          step.kind === "chat"
                            ? t("Configure the chat model")
                            : t("Configure the embedding model")
                        }
                        className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
                      >
                        {t("Configure")}
                      </Link>
                    ) : null}
                  </div>
                  <div className="neu-well space-y-1.5 rounded-md bg-input px-3.5 py-2.5">
                    {step.pluginName ? (
                      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-sm">
                        <span className="font-semibold">{step.pluginName}</span>
                        <span className="break-all font-mono">{step.model}</span>
                        {step.usesDefault ? (
                          <span className="font-mono text-[11px] text-muted-foreground">
                            {t("default")}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    <StepStatus step={step} />
                  </div>
                </Card>
              </li>
            ))}
          </ol>
        </section>

        {data.isOwner ? (
          <Form method="post" className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <button
              type="submit"
              disabled={testing}
              className="neu-button rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              {testing ? t("Testing models…") : t("Check and finish")}
            </button>
            <p className="min-w-0 flex-[1_1_15rem] text-xs text-muted-foreground">
              {t(
                "Braino opens when both models are ready. You can change either one later in Admin.",
              )}
            </p>
          </Form>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("Only a workspace owner can set up models.")}
          </p>
        )}
        {actionData?.error ? (
          <p role="alert" className="text-xs text-destructive">
            {actionData.error}
          </p>
        ) : null}
      </div>
    </PageMain>
  );
}
