import { useT } from "@doco/shared/i18n/react";
import { Check } from "lucide-react";
import { Link, redirect, useLoaderData } from "react-router";
import { Card } from "~/components/card";
import {
  BackLink,
  ModelSetupBreadcrumb,
  PluginSummary,
  modelTitle,
} from "~/components/model-setup";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import {
  type ModelKind,
  type ModelPluginEntry,
  includedWithBraino,
  modelKind,
} from "~/lib/model-plugin-catalog";
import { loadModelSetup } from "~/lib/model-setup.server";
import { metaTranslator } from "~/locales/catalog";

interface PluginRow {
  plugin: ModelPluginEntry;
  /** The model this plugin runs for the workspace, when it is the one chosen. */
  chosenModel: string | null;
  assigned: boolean;
}

interface LoaderData {
  kind: ModelKind;
  firstRun: boolean;
  included: PluginRow[];
  marketplace: PluginRow[];
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Model setup · Braino") }];
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { model?: string };
}): Promise<LoaderData> {
  const kind = modelKind(params.model);
  if (!kind) throw new Response("Not found", { status: 404 });
  const setup = await loadModelSetup(request);
  if (!setup.isOwner) throw redirect("/admin/models");
  const step = setup.steps.find((candidate) => candidate.kind === kind);
  const rows = setup.catalog
    .filter((plugin) => plugin.kind === kind)
    .map((plugin) => ({
      plugin,
      chosenModel: step?.pluginId === plugin.id ? step.model : null,
      assigned: step?.pluginId === plugin.id && step.status !== "preselected",
    }));
  return {
    kind,
    firstRun: !setup.ready,
    included: rows.filter((row) => includedWithBraino(row.plugin)),
    marketplace: rows.filter((row) => !includedWithBraino(row.plugin)),
  };
}

function PluginGroup({
  kind,
  title,
  description,
  rows,
}: {
  kind: ModelKind;
  title: string;
  description: string;
  rows: PluginRow[];
}) {
  const t = useT();
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2.5">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Card className="px-5 py-1">
        <ul className="divide-y divide-border">
          {rows.map(({ plugin, chosenModel, assigned }) => (
            <li key={plugin.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2.5 py-3.5">
              <div
                aria-hidden
                className="neu-well flex size-10 items-center justify-center rounded-md bg-input text-lg font-bold text-primary"
              >
                {plugin.name.charAt(0)}
              </div>
              <div className="min-w-0 flex-[1_1_17rem]">
                <PluginSummary plugin={plugin} />
                {chosenModel ? (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-primary">
                    <Check aria-hidden className="size-3.5 shrink-0" />
                    <span className="break-all">
                      {assigned
                        ? t("In use · {model}", { model: chosenModel })
                        : t("Pre-selected · {model}", { model: chosenModel })}
                    </span>
                  </p>
                ) : null}
              </div>
              <Link
                to={`/admin/models/${kind}/${plugin.id}`}
                aria-label={
                  chosenModel
                    ? t("Change the model of {plugin}", { plugin: plugin.name })
                    : t("Select {plugin}", { plugin: plugin.name })
                }
                className="neu-button neu-small rounded-md px-3.5 py-1.5 text-xs font-semibold"
              >
                {chosenModel ? t("Change model") : t("Select")}
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

export default function ModelPluginsPage() {
  const t = useT();
  const data = useLoaderData() as LoaderData;
  const chat = data.kind === "chat";
  return (
    <PageMain className="py-6">
      <div className="max-w-3xl space-y-6">
        <div className="space-y-3.5">
          <PageHeader
            breadcrumb={
              <ModelSetupBreadcrumb
                firstRun={data.firstRun}
                trail={[{ label: modelTitle(t, data.kind) }]}
              />
            }
            title={chat ? t("Choose a chat model plugin") : t("Choose an embedding model plugin")}
          >
            <p className="text-xs text-muted-foreground">
              {chat
                ? t(
                    "The chat model writes answers, summaries, and the links between records. Bigger models answer better and cost more to run.",
                  )
                : t(
                    "The embedding model turns records into numbers so search finds meaning, not only matching words. Changing it later re-indexes every record.",
                  )}
            </p>
          </PageHeader>
          <BackLink to="/admin/models">{t("Model setup")}</BackLink>
        </div>

        <PluginGroup
          kind={data.kind}
          title={t("Included with Braino")}
          description={t("Already on this server. Nothing to install.")}
          rows={data.included}
        />
        <PluginGroup
          kind={data.kind}
          title={t("From the marketplace")}
          description={
            chat
              ? t(
                  "Plugins that offer a chat model. Each one says what it can reach before you add it.",
                )
              : t(
                  "Plugins that offer an embedding model. Each one says what it can reach before you add it.",
                )
          }
          rows={data.marketplace}
        />
        {data.included.length + data.marketplace.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("This server has no plugins for this model.")}
          </p>
        ) : null}
      </div>
    </PageMain>
  );
}
