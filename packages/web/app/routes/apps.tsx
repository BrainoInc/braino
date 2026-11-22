import { withClient } from "@doco/db";
import { listPluginInstallations } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Link, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { APP_IDS, APP_PLUGIN_IDS, type AppId } from "~/lib/app-catalog";
import { loadModelSetup } from "~/lib/model-setup.server";
import { metaTranslator } from "~/locales/catalog";

type View = "browse" | "installed";

interface AppRow {
  id: AppId;
  installed: boolean;
  active: boolean;
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Apps · Braino") }];
}

export async function loader({ request }: { request: Request }) {
  const setup = await loadModelSetup(request);
  if (!setup.isOwner) throw new Response("Owner access required", { status: 403 });
  const installations = await withClient((client) =>
    listPluginInstallations(client, {
      workspaceId: setup.workspace.id,
      userId: setup.userId,
    }),
  );
  const view: View =
    new URL(request.url).searchParams.get("view") === "installed" ? "installed" : "browse";
  const apps: AppRow[] = APP_IDS.map((id) => {
    const pluginIds = APP_PLUGIN_IDS[id] as readonly string[];
    const matches = installations.filter((item) => pluginIds.includes(item.manifest.id));
    const enabled = matches.filter((item) => item.enabled);
    return {
      id,
      installed: enabled.length > 0,
      active:
        id === "ollama" || id === "openai"
          ? pluginIds.every((pluginId) =>
              setup.steps.some(
                (step) => step.pluginId === pluginId && step.status !== "preselected",
              ),
            )
          : enabled.length > 0,
    };
  });
  return {
    workspace: setup.workspace,
    ready: setup.ready,
    view,
    apps: view === "installed" ? apps.filter((app) => app.installed) : apps,
  };
}

function appCopy(t: ReturnType<typeof useT>, id: AppId) {
  switch (id) {
    case "ollama":
      return {
        name: "Ollama",
        description: t(
          "Run private AI on this server without sending workspace data to a model provider.",
        ),
        capabilities: [t("Chat responses"), t("Semantic search")],
      };
    case "openai":
      return {
        name: "OpenAI",
        description: t("Use your OpenAI account for Braino answers and semantic search."),
        capabilities: [t("Chat responses"), t("Semantic search")],
      };
    case "slack":
      return {
        name: "Slack",
        description: t("Let your team talk to Señor Braino from Slack."),
        capabilities: [t("Team chat")],
      };
    case "resend":
      return {
        name: "Resend",
        description: t("Send workspace email through your Resend account."),
        capabilities: [t("Email delivery")],
      };
  }
}

export default function AppsPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <Link to="/admin">{t("Admin")}</Link>
            <span aria-hidden>›</span>
            <span>{t("Apps")}</span>
          </nav>
        }
        title={t("Apps")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Install and manage the services this workspace uses.")}
        </p>
      </PageHeader>

      {!data.ready ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle>{t("Choose how Braino thinks and searches")}</CardTitle>
            <CardDescription>
              {t("Install either Ollama or OpenAI to finish setting up this workspace.")}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <nav className="flex gap-2" aria-label={t("App views")}>
        <Link
          to="/apps"
          aria-current={data.view === "browse" ? "page" : undefined}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
        >
          {t("Browse")}
        </Link>
        <Link
          to="/apps?view=installed"
          aria-current={data.view === "installed" ? "page" : undefined}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
        >
          {t("Installed")}
        </Link>
      </nav>

      {data.apps.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {data.apps.map((app) => {
            const copy = appCopy(t, app.id);
            return (
              <Card key={app.id} className="flex h-full flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle>{copy.name}</CardTitle>
                      <CardDescription>{copy.description}</CardDescription>
                    </div>
                    <span className="rounded-full border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                      {app.active ? t("Active") : app.installed ? t("Installed") : t("Available")}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-4">
                  <ul className="flex flex-wrap gap-2">
                    {copy.capabilities.map((capability) => (
                      <li key={capability} className="neu-well rounded-md px-2.5 py-1 text-xs">
                        {capability}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to={`/apps/${app.id}`}
                    className="neu-button self-start rounded-md px-4 py-2 text-sm font-semibold"
                  >
                    {app.installed ? t("Manage") : t("View app")}
                  </Link>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("No apps are installed yet.")}</p>
      )}
    </PageMain>
  );
}
