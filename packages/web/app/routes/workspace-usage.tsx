import { getWorkspaceUsageReport } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { WorkspaceUsagePage } from "@doco/ui";
import { Link, redirect, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

export function headers({ parentHeaders }: { parentHeaders: Headers }) {
  const headers = new Headers(parentHeaders);
  headers.set("Cache-Control", "private, no-store");
  return headers;
}

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Workspace usage") }];
}

export async function loader({
  request,
  params,
}: { request: Request; params: { workspaceHandle: string } }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect(`/?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  const report = await getWorkspaceUsageReport(params.workspaceHandle, user.id);
  if (!report) {
    const t = await requestTranslator(request);
    throw new Response(t('Workspace "{handle}" not found.', { handle: params.workspaceHandle }), {
      status: 404,
    });
  }
  return { report, handle: params.workspaceHandle };
}

export default function Usage() {
  const t = useT();
  const { report, handle } = useLoaderData<typeof loader>();
  return (
    <WorkspaceUsagePage
      report={report}
      locale={t.locale}
      breadcrumb={
        <Link className="text-xs text-muted-foreground hover:underline" to="/">
          {handle}
        </Link>
      }
      labels={{
        title: t("Workspace usage"),
        updated: t("Updated"),
        timeRange: t("Time range"),
        daily: t("Daily"),
        quarterHourly: t("15-minute intervals"),
        month: t("This month (UTC)"),
        fiveHours: t("Last 5 hours"),
        queries: t("Queries"),
        replies: t("Señor Braino replies"),
        ingestedTokens: t("Ingested tokens"),
        storedBytes: t("Storage used"),
        ingestionDescription: t(
          "Braino estimates one token per four characters and rounds up for each text revision.",
        ),
        storageDescription: t("Total source text retained at the end of each interval."),
      }}
    />
  );
}
