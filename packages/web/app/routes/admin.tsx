import { withClient } from "@doco/db";
import {
  type ActivityPeriod,
  WorkspaceAdminError,
  getSingleWorkspaceState,
  getWorkspaceAdminOverview,
  updateWorkspaceSettings,
} from "@doco/host";
import { type Translator, msg } from "@doco/shared/i18n";
import { type ReactTranslator, useT } from "@doco/shared/i18n/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@doco/ui";
import { PageHeader } from "@doco/ui";
import { PageMain } from "@doco/ui";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { loadModelSetup } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

interface ActionData {
  saved?: boolean;
  error?: string;
}

interface DeploymentStatus {
  version: string;
  publicHost: string;
  postgres: string;
  qdrant: string;
  codeLinker: string;
  search: string;
  models: string;
  transport: string;
}

const METRIC_PERIODS = [
  { value: "24h", label: msg("24 hours") },
  { value: "7d", label: msg("7 days") },
  { value: "30d", label: msg("30 days") },
] as const satisfies readonly { value: ActivityPeriod; label: string }[];

function metricPeriod(request: Request): ActivityPeriod {
  const value = new URL(request.url).searchParams.get("period");
  return METRIC_PERIODS.some((option) => option.value === value)
    ? (value as ActivityPeriod)
    : "24h";
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Workspace administration · Braino") }];
}

function deploymentStatus(
  request: Request,
  plugins: { ready: boolean; embedding: boolean },
  t: Translator,
): DeploymentStatus {
  const publicHost = (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(
    /\/$/,
    "",
  );
  const embeddingProvider = process.env.DOCO_EMBEDDING_PROVIDER?.trim().toLowerCase();
  const hasEmbeddingKey = Boolean(
    process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY || process.env.COHERE_API_KEY,
  );
  return {
    version: process.env.DOCO_VERSION?.trim() || "local",
    publicHost,
    postgres: t("Connected"),
    qdrant: process.env.QDRANT_URL?.trim() ? t("Configured") : t("Not configured"),
    codeLinker:
      process.env.BRAINO_CODELINKER_URL?.trim() && process.env.BRAINO_CODELINKER_API_TOKEN?.trim()
        ? t("Configured")
        : t("Not configured"),
    search: plugins.embedding
      ? t("Plugin embeddings")
      : embeddingProvider === "none" || (!embeddingProvider && !hasEmbeddingKey)
        ? t("Keyword search")
        : embeddingProvider
          ? t("{provider} embeddings", { provider: embeddingProvider })
          : t("automatic embeddings"),
    models: plugins.ready ? t("Ready") : t("Setup required"),
    transport: publicHost.startsWith("https://")
      ? "HTTPS"
      : publicHost.startsWith("http://localhost") || publicHost.startsWith("http://127.0.0.1")
        ? t("Loopback HTTP")
        : "HTTP",
  };
}

function adminResponse(error: unknown): never {
  if (error instanceof WorkspaceAdminError) {
    throw new Response(error.message, { status: error.status });
  }
  throw error;
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const t = await requestTranslator(request);
  try {
    const overview = await withClient((client) =>
      getWorkspaceAdminOverview(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        period: metricPeriod(request),
      }),
    );
    const models = await loadModelSetup(request);
    return {
      overview,
      deployment: deploymentStatus(
        request,
        {
          ready: models.ready,
          embedding: models.steps.some(
            (step) => step.kind === "embedding" && step.status === "ready",
          ),
        },
        t,
      ),
    };
  } catch (error) {
    adminResponse(error);
  }
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

export async function action({ request }: { request: Request }): Promise<ActionData | Response> {
  const t = await requestTranslator(request);
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: t("Sign in first.") }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized)
    return Response.json({ error: t("Finish setup first.") }, { status: 409 });
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: t(error.message) }, { status: error.status });
    }
    throw error;
  }
  const intent = text(form, "intent");
  try {
    if (intent !== "update_workspace") {
      return Response.json({ error: t("Unknown admin action.") }, { status: 400 });
    }
    await withClient((client) =>
      updateWorkspaceSettings(client, {
        workspaceId: state.workspace.id,
        userId: user.id,
        name: text(form, "name"),
        constitution: text(form, "constitution"),
        timesPublic: form.has("times_public"),
        timesTimeZone: text(form, "times_timezone"),
      }),
    );
    return { saved: true };
  } catch (error) {
    if (error instanceof WorkspaceAdminError) {
      return Response.json({ error: t(error.message) }, { status: error.status });
    }
    throw error;
  }
}

function Breadcrumb({ handle }: { handle: string }) {
  const t = useT();
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        {"Braino"}
      </Link>
      <span aria-hidden>›</span>
      <Link to="/" className="hover:underline">
        {handle}
      </Link>
      <span aria-hidden>›</span>
      <span>{t("Admin")}</span>
    </nav>
  );
}

function Metric({
  label,
  value,
  comparison,
  note,
}: {
  label: string;
  value: number;
  comparison?: string;
  note?: string;
}) {
  return (
    <div className="neu-surface space-y-2 rounded-lg bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="flex flex-wrap items-baseline gap-2">
        <span className="text-2xl font-semibold leading-none">{value}</span>
        {comparison ? (
          <span className="text-[11px] font-semibold text-muted-foreground">{comparison}</span>
        ) : null}
      </p>
      {note ? <p className="text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

function comparison(
  t: ReactTranslator,
  value: number,
  previous: number,
  period: ActivityPeriod,
): string {
  const difference = value - previous;
  const change = difference > 0 ? `+${difference}` : difference < 0 ? `−${-difference}` : "±0";
  return t("{change} vs previous {period, select, 24h {24 hours} 7d {7 days} other {30 days}}", {
    change,
    period,
  });
}

function AdminLink({
  to,
  title,
  description,
}: {
  to: string;
  title: string;
  description: string;
}) {
  return (
    <Link to={to} className="neu-button block rounded-lg px-4 py-3">
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs font-normal text-muted-foreground">{description}</span>
    </Link>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-all text-end font-mono text-xs">{value}</dd>
    </div>
  );
}

export default function AdminPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as ActionData | undefined;
  const { overview, deployment } = data;
  const period =
    METRIC_PERIODS.find((option) => option.value === overview.activity.period) ?? METRIC_PERIODS[0];
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={<Breadcrumb handle={overview.workspace.handle} />}
        title={t("Workspace administration")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Operate this Braino deployment and its one workspace.")}
        </p>
      </PageHeader>

      <section className="space-y-3" aria-labelledby="metrics-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="metrics-title" className="text-lg font-semibold">
              {t("Metrics")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("Rolling activity for this workspace.")}
            </p>
          </div>
          <nav aria-label={t("Metrics time period")} className="flex flex-wrap gap-2">
            {METRIC_PERIODS.map((option) => (
              <Link
                key={option.value}
                to={`?period=${option.value}`}
                aria-current={option.value === overview.activity.period ? "true" : undefined}
                className={`neu-button rounded-md px-3 py-1.5 text-xs font-semibold ${
                  option.value === overview.activity.period
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground"
                }`}
              >
                {t(option.label)}
              </Link>
            ))}
          </nav>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label={t(
              "Active agents · last {period, select, 24h {24 hours} 7d {7 days} other {30 days}}",
              { period: period.value },
            )}
            value={overview.activity.activeAgents.current}
            comparison={comparison(
              t,
              overview.activity.activeAgents.current,
              overview.activity.activeAgents.previous,
              period.value,
            )}
            note={t("Distinct agents that read or wrote")}
          />
          <Metric
            label={t(
              "Queries · last {period, select, 24h {24 hours} 7d {7 days} other {30 days}}",
              { period: period.value },
            )}
            value={overview.activity.queries.current}
            comparison={comparison(
              t,
              overview.activity.queries.current,
              overview.activity.queries.previous,
              period.value,
            )}
            note={t("{count} by agents", { count: overview.activity.queries.byAgents })}
          />
          <Metric
            label={t("Writes · last {period, select, 24h {24 hours} 7d {7 days} other {30 days}}", {
              period: period.value,
            })}
            value={overview.activity.writes.current}
            comparison={comparison(
              t,
              overview.activity.writes.current,
              overview.activity.writes.previous,
              period.value,
            )}
            note={t("{count} by agents", { count: overview.activity.writes.byAgents })}
          />
          <Metric
            label={t(
              "Imports · last {period, select, 24h {24 hours} 7d {7 days} other {30 days}}",
              { period: period.value },
            )}
            value={overview.activity.imports.current}
            comparison={comparison(
              t,
              overview.activity.imports.current,
              overview.activity.imports.previous,
              period.value,
            )}
            note={t("What connected sources brought in")}
          />
        </div>
        <div>
          <h3 className="text-sm font-semibold">{t("Workspace totals")}</h3>
          <p className="text-xs text-muted-foreground">{t("Current totals for this workspace.")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label={t("Collections")} value={overview.counts.collections} />
          <Metric label={t("Records")} value={overview.counts.records} />
          <Metric label={t("Collaborators")} value={overview.counts.collaborators} />
          <Metric label={t("Connections")} value={overview.counts.connections} />
          <Metric label={t("Active MCP tokens")} value={overview.counts.mcpTokens} />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("Workspace settings")}</CardTitle>
            <CardDescription>
              {t("The handle is permanent because it anchors collection names and agent URLs.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="update_workspace" />
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Workspace name")}</span>
                <input
                  name="name"
                  defaultValue={overview.workspace.name}
                  required
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Workspace handle")}</span>
                <input
                  value={overview.workspace.handle}
                  readOnly
                  aria-readonly="true"
                  className="w-full rounded-md px-3 py-2 font-mono text-sm text-muted-foreground"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Constitution")}</span>
                <textarea
                  name="constitution"
                  defaultValue={overview.workspace.constitution}
                  rows={8}
                  className="w-full rounded-md px-3 py-2 text-sm leading-6"
                />
              </label>
              <fieldset className="neu-well space-y-3 rounded-lg p-4">
                <legend className="px-1 text-sm font-semibold">{t("Braino Times")}</legend>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "Publish one local edition each calendar day. Use an IANA timezone such as {first} or {second}.",
                    { first: "Africa/Lagos", second: "America/Los_Angeles" },
                  )}
                </p>
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">
                    {t("Publication timezone")}
                  </span>
                  <input
                    name="times_timezone"
                    defaultValue={overview.workspace.timesTimeZone}
                    required
                    className="w-full rounded-md px-3 py-2 font-mono text-sm"
                  />
                </label>
                <label className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    name="times_public"
                    defaultChecked={overview.workspace.timesPublic}
                    className="mt-0.5"
                  />
                  <span>
                    {t(
                      "Make Times public. Signed-out readers see stories from public collections only.",
                    )}
                  </span>
                </label>
                <Link to="/times" className="inline-block text-xs font-semibold hover:underline">
                  {t("View Braino Times")}
                </Link>
              </fieldset>
              {actionData?.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {actionData.error}
                </p>
              ) : null}
              {actionData?.saved ? (
                <output className="block text-xs text-muted-foreground">
                  {t("Workspace settings saved.")}
                </output>
              ) : null}
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {t("Save workspace")}
              </button>
            </Form>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{t("Administration")}</CardTitle>
              <CardDescription>
                {t("Manage the team and the systems connected to its knowledge.")}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <AdminLink
                to="/collaborators"
                title={t("People and access")}
                description={t("Add collaborators and manage roles.")}
              />
              <AdminLink
                to="/integrations"
                title={t("Sources")}
                description={t("Connect sources, GitHub, and webhooks.")}
              />
              <AdminLink
                to="/plugins"
                title={t("Plugins")}
                description={t("Install and manage workspace plugins.")}
              />
              <AdminLink
                to="/mcp-tokens"
                title={t("Agent access")}
                description={t(
                  "Connect an agent to briefs, records, feedback, and atomic authoring in this workspace.",
                )}
              />
              <AdminLink
                to="/"
                title={t("Workspace")}
                description={t("Return to collections and the constitution.")}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("Deployment")}</CardTitle>
              <CardDescription>
                {t("Configuration status without exposing secret values.")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl>
                <StatusRow label={t("Version")} value={deployment.version} />
                <StatusRow label={t("Public URL")} value={deployment.publicHost} />
                <StatusRow label={"PostgreSQL"} value={deployment.postgres} />
                <StatusRow label={"Qdrant"} value={deployment.qdrant} />
                <StatusRow label={"CodeLinker"} value={deployment.codeLinker} />
                <StatusRow label={t("AI plugins")} value={deployment.models} />
                <StatusRow label={t("Search")} value={deployment.search} />
                <StatusRow label={t("Transport")} value={deployment.transport} />
              </dl>
            </CardContent>
          </Card>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("Operations")}</CardTitle>
          <CardDescription>
            {t("Run privileged maintenance on the host, outside the web process.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="neu-well overflow-x-auto rounded-md px-4 py-3 font-mono text-xs leading-6">
            <code>
              {
                "./doco doctor\n./doco backup\n./doco restore backups/<archive>.tar.gz\n./doco upgrade"
              }
            </code>
          </pre>
        </CardContent>
      </Card>
    </PageMain>
  );
}
