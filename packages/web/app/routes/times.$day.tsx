import { withClient } from "@doco/db";
import { getSingleWorkspaceState, loadTimesEdition } from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Link, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

export function meta({
  data,
  matches,
}: { data?: { title?: string }; matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: data?.title ?? t("Braino Times") }];
}

export async function loader({ request, params }: { request: Request; params: { day?: string } }) {
  const day = params.day ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Response("Edition not found.", { status: 404 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const user = await getCurrentUser(request);
  const edition = await withClient((client) =>
    loadTimesEdition(client, {
      workspaceId: state.workspace.id,
      day,
      userId: user?.id ?? null,
    }),
  );
  if (edition.kind !== "edition") throw new Response("Edition not found.", { status: 404 });
  const t = await requestTranslator(request);
  return { ...edition, title: t("The {workspace} Times", { workspace: state.workspace.name }) };
}

export default function TimesEditionPage() {
  const edition = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const t = useT();
  return (
    <PageMain className="space-y-6 py-8">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/" className="hover:underline">
              {"Braino"}
            </Link>
            <span aria-hidden>›</span>
            <Link to="/times" className="hover:underline">
              {t("Times")}
            </Link>
          </nav>
        }
        title={edition.title}
      >
        <p className="text-sm text-muted-foreground">
          {edition.day}
          {edition.public ? ` · ${t("Public edition")}` : ""}
        </p>
      </PageHeader>

      {edition.stories.length ? (
        <section className="grid gap-4 md:grid-cols-2" aria-label={t("Front page stories")}>
          {edition.stories.map((story, index) => (
            <Card key={story.id} className={index === 0 ? "md:col-span-2" : undefined}>
              <CardHeader>
                <p className="font-mono text-[11px] uppercase text-muted-foreground">
                  {story.collectionHandle} · {story.nodeType}
                </p>
                <CardTitle className={index === 0 ? "text-2xl" : undefined}>
                  <Link to={story.url} className="hover:underline">
                    {story.headline}
                  </Link>
                </CardTitle>
              </CardHeader>
              {story.takeaway ? (
                <CardContent>
                  <p className="text-sm text-muted-foreground">{story.takeaway}</p>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </section>
      ) : (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            {t("No publishable records were added during this edition’s period.")}
          </CardContent>
        </Card>
      )}
    </PageMain>
  );
}
