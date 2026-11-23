import { withClient } from "@doco/db";
import { listPluginInstallations } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import {
  BUILT_IN_PLUGIN_BRANDS,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageMain,
  PluginManager,
} from "@doco/ui";
import { Link, useLoaderData } from "react-router";
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
    <PageMain className="py-6">
      <PluginManager
        LinkComponent={Link}
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
        description={t("Install and manage each workspace plugin independently.")}
        readiness={
          !data.ready ? (
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
                  {t("Embedding plugin")}:{" "}
                  {data.requirements.embedding ? t("Ready") : t("Required")}
                </span>
              </CardContent>
            </Card>
          ) : undefined
        }
        viewsLabel={t("Plugin views")}
        views={[
          { label: t("Browse"), href: "/plugins", current: data.view === "browse" },
          {
            label: t("Installed"),
            href: "/plugins?view=installed",
            current: data.view === "installed",
          },
        ]}
        groups={groups.map((group) => ({
          title: group.title,
          plugins: data.plugins
            .filter((plugin) => group.ids.includes(plugin.id))
            .map((plugin) => {
              const copy = pluginCopy(t, plugin.id);
              return {
                id: plugin.id,
                brand: BUILT_IN_PLUGIN_BRANDS[plugin.id],
                name: copy.name,
                description: copy.description,
                capability: copy.capability,
                status: plugin.needsAttention
                  ? t("Needs attention")
                  : plugin.active
                    ? t("Active")
                    : plugin.installed
                      ? t("Installed")
                      : t("Available"),
                actionLabel: plugin.installed ? t("Manage") : t("View plugin"),
                href: `/plugins/${plugin.id}`,
              };
            }),
        }))}
        emptyLabel={t("No plugins are installed yet.")}
      />
    </PageMain>
  );
}
