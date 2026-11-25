import { withClient } from "@braino/db";
import { getSingleWorkspaceState, latestTimesEditionDay, loadTimesEdition } from "@braino/host";
import { useT } from "@braino/shared/i18n/react";
import { PageHeader } from "@braino/ui";
import { PageMain } from "@braino/ui";
import { Link, redirect, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { metaTranslator } from "~/locales/catalog";

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Braino Times") }];
}

export async function loader({ request }: { request: Request }) {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const user = await getCurrentUser(request);
  const day = await withClient((client) => latestTimesEditionDay(client, state.workspace.id));
  if (day) {
    const edition = await withClient((client) =>
      loadTimesEdition(client, {
        workspaceId: state.workspace.id,
        day,
        userId: user?.id ?? null,
      }),
    );
    if (edition.kind === "hidden") throw new Response("Edition not found.", { status: 404 });
    if (edition.kind === "edition") throw redirect(`/times/${day}`);
  }
  return { workspaceName: state.workspace.name };
}

export default function EmptyTimesPage() {
  const { workspaceName } = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const t = useT();
  return (
    <PageMain className="space-y-6 py-8">
      <PageHeader
        breadcrumb={
          <Link to="/" className="font-mono text-[11px] text-muted-foreground hover:underline">
            {"Braino"}
          </Link>
        }
        title={t("The {workspace} Times", { workspace: workspaceName })}
      >
        <p className="text-sm text-muted-foreground">
          {t("The first edition will appear after the scheduler publishes today’s activity.")}
        </p>
      </PageHeader>
    </PageMain>
  );
}
