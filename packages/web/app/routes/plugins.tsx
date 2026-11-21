import { withClient } from "@doco/db";
import { listPluginInstallations } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Link, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { modelTitle } from "~/components/model-setup";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { loadModelSetup } from "~/lib/model-setup.server";
import { metaTranslator } from "~/locales/catalog";

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
  const enabled = installations.filter((plugin) => plugin.enabled);
  return {
    workspace: setup.workspace,
    models: setup.steps,
    email: enabled.find((plugin) => plugin.manifest.capabilities["email.send"] === 1) ?? null,
    slack: enabled.find((plugin) => plugin.manifest.id === "braino.slack") ?? null,
  };
}

function StatusRow({
  name,
  value,
  action,
}: {
  name: string;
  value: string;
  action?: { label: string; to: string };
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border py-3 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{name}</p>
        <p className="break-all font-mono text-xs text-muted-foreground">{value}</p>
      </div>
      {action ? (
        <Link to={action.to} className="neu-button rounded-md px-3 py-2 text-xs font-semibold">
          {action.label}
        </Link>
      ) : null}
    </div>
  );
}

export default function PluginsPage() {
  const t = useT();
  const data = useLoaderData<typeof loader>();
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              {"Braino"}
            </Link>
            <span aria-hidden>›</span>
            <span>{data.workspace.handle}</span>
            <span aria-hidden>›</span>
            <Link to="/admin" className="hover:underline">
              {t("Admin")}
            </Link>
            <span aria-hidden>›</span>
            <span>{t("Plugins")}</span>
          </nav>
        }
        title={t("Plugins")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Manage the capabilities Braino uses to think, send, and answer.")}
        </p>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>{t("Model plugins")}</CardTitle>
          <CardDescription>
            {t(
              "The workspace opens only when one chat plugin and one embedding plugin are configured.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.models.map((model) => (
            <StatusRow
              key={model.kind}
              name={modelTitle(t, model.kind)}
              value={
                model.pluginName
                  ? `${model.pluginName} · ${model.model ?? t("Not configured yet.")}`
                  : t("Not configured yet.")
              }
            />
          ))}
          <Link
            to="/admin/models"
            className="neu-button mt-4 inline-flex rounded-md px-4 py-2 text-sm font-semibold"
          >
            {t("Change models")}
          </Link>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("Communication plugins")}</CardTitle>
          <CardDescription>
            {t("Manage the services Braino uses to send email and answer in team chat.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StatusRow
            name={t("Email provider")}
            value={data.email?.manifest.name ?? t("Not configured yet.")}
            action={{ label: t("Manage email provider"), to: "/integrations/email" }}
          />
          <StatusRow
            name={t("Señor Braino for Slack")}
            value={data.slack ? t("Connected") : t("Not configured yet.")}
            action={{ label: t("Manage Slack app"), to: "/integrations/slack-app" }}
          />
        </CardContent>
      </Card>
    </PageMain>
  );
}
