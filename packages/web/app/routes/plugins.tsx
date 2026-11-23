import { withClient } from "@doco/db";
import { listPluginInstallations } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Link, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { PluginLogo } from "~/components/plugin-logo";
import { loadModelSetup } from "~/lib/model-setup.server";
import {
  PLUGIN_MANIFEST_IDS,
  PLUGIN_PAGE_IDS,
  type PluginPageId,
  isModelPluginPage,
} from "~/lib/plugin-catalog";
import { metaTranslator } from "~/locales/catalog";

type View = "browse" | "installed";

interface PluginRow {
  id: PluginPageId;
  installed: boolean;
  active: boolean;
  needsAttention: boolean;
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Plugins · Braino") }];
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
  const plugins: PluginRow[] = PLUGIN_PAGE_IDS.map((id) => {
    const manifestId = PLUGIN_MANIFEST_IDS[id];
    const modelPlugin = isModelPluginPage(id)
      ? setup.installed.find((item) => item.pluginId === manifestId)
      : null;
    const installed = modelPlugin
      ? true
      : installations.some((item) => item.manifest.id === manifestId && item.enabled);
    return {
      id,
      installed,
      active: modelPlugin?.active ?? (!isModelPluginPage(id) && installed),
      needsAttention: Boolean(modelPlugin && !modelPlugin.verified),
    };
  });
  return {
    workspace: setup.workspace,
    ready: setup.ready,
    view,
    requirements: Object.fromEntries(
      setup.steps.map((step) => [step.kind, step.status === "ready"]),
    ) as Record<"chat" | "embedding", boolean>,
    plugins: view === "installed" ? plugins.filter((plugin) => plugin.installed) : plugins,
  };
}

function pluginCopy(t: ReturnType<typeof useT>, id: PluginPageId) {
  switch (id) {
    case "ollama-chat":
      return {
        name: "Ollama Chat",
        description: t("Answer questions and write summaries privately with Ollama."),
        capability: t("Chat"),
      };
    case "ollama-embedding":
      return {
        name: "Ollama Embeddings",
        description: t("Power semantic search privately with Ollama."),
        capability: t("Embeddings"),
      };
    case "openai-chat":
      return {
        name: "OpenAI Chat",
        description: t("Use an OpenAI model for answers and summaries."),
        capability: t("Chat"),
      };
    case "openai-embedding":
      return {
        name: "OpenAI Embeddings",
        description: t("Use an OpenAI embedding model for semantic search."),
        capability: t("Embeddings"),
      };
    case "slack":
      return {
        name: "Slack",
        description: t("Let your team talk to Señor Braino from Slack."),
        capability: t("Team chat"),
      };
    case "resend":
      return {
        name: "Resend",
        description: t("Send workspace email through your Resend account."),
        capability: t("Email delivery"),
      };
  }
}

export default function PluginsPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  const groups: Array<{
    title: string;
    ids: readonly PluginPageId[];
  }> = [
    {
      title: t("Chat"),
      ids: ["ollama-chat", "openai-chat"] as const,
    },
    {
      title: t("Embeddings"),
      ids: ["ollama-embedding", "openai-embedding"] as const,
    },
    {
      title: t("Connections"),
      ids: ["slack", "resend"] as const,
    },
  ];
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <Link to="/admin">{t("Admin")}</Link>
            <span aria-hidden>›</span>
            <span>{t("Plugins")}</span>
          </nav>
        }
        title={t("Plugins")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Install and manage each workspace plugin independently.")}
        </p>
      </PageHeader>

      {!data.ready ? (
        <Card className="border-primary">
          <CardHeader>
            <CardTitle>{t("Complete AI setup")}</CardTitle>
            <CardDescription>
              {t(
                "Install one Chat plugin and one Embedding plugin. They may use different providers and credentials.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2 text-xs">
            <span className="neu-well rounded-md px-3 py-2">
              {t("Chat plugin")}: {data.requirements.chat ? t("Ready") : t("Required")}
            </span>
            <span className="neu-well rounded-md px-3 py-2">
              {t("Embedding plugin")}: {data.requirements.embedding ? t("Ready") : t("Required")}
            </span>
          </CardContent>
        </Card>
      ) : null}

      <nav className="flex gap-2" aria-label={t("Plugin views")}>
        <Link
          to="/plugins"
          aria-current={data.view === "browse" ? "page" : undefined}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
        >
          {t("Browse")}
        </Link>
        <Link
          to="/plugins?view=installed"
          aria-current={data.view === "installed" ? "page" : undefined}
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
        >
          {t("Installed")}
        </Link>
      </nav>

      {data.plugins.length > 0 ? (
        groups.map((group) => {
          const plugins = data.plugins.filter((plugin) => group.ids.includes(plugin.id));
          if (plugins.length === 0) return null;
          return (
            <section key={group.title} className="space-y-3">
              <div>
                <h2 className="font-serif text-xl font-semibold">{group.title}</h2>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                {plugins.map((plugin) => {
                  const copy = pluginCopy(t, plugin.id);
                  return (
                    <Card key={plugin.id} className="flex h-full flex-col">
                      <CardHeader>
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-start gap-3">
                            <PluginLogo pluginId={plugin.id} />
                            <div className="min-w-0">
                              <CardTitle>{copy.name}</CardTitle>
                              <CardDescription>{copy.description}</CardDescription>
                            </div>
                          </div>
                          <span className="rounded-full border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                            {plugin.needsAttention
                              ? t("Needs attention")
                              : plugin.active
                                ? t("Active")
                                : plugin.installed
                                  ? t("Installed")
                                  : t("Available")}
                          </span>
                        </div>
                      </CardHeader>
                      <CardContent className="flex flex-1 flex-col justify-between gap-4">
                        <p className="neu-well self-start rounded-md px-2.5 py-1 text-xs">
                          {copy.capability}
                        </p>
                        <Link
                          to={`/plugins/${plugin.id}`}
                          className="neu-button self-start rounded-md px-4 py-2 text-sm font-semibold"
                        >
                          {plugin.installed ? t("Manage") : t("View plugin")}
                        </Link>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })
      ) : (
        <p className="text-sm text-muted-foreground">{t("No plugins are installed yet.")}</p>
      )}
    </PageMain>
  );
}
