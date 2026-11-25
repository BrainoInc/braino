import { withClient } from "@braino/db";
import { getSingleWorkspaceState } from "@braino/host";
import { useT } from "@braino/shared/i18n/react";
import { Card, CardContent } from "@braino/ui";
import { PageHeader } from "@braino/ui";
import { PageMain } from "@braino/ui";
import { Form, Link, redirect, useLoaderData } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { searchAsWorkspaceMember } from "~/lib/workspace-search.server";
import { metaTranslator } from "~/locales/catalog";

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Search · Braino") }];
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const query = new URL(request.url).searchParams.get("q")?.trim().slice(0, 500) ?? "";
  const results = await searchAsWorkspaceMember({
    source: "ui",
    workspaceId: state.workspace.id,
    userId: user.id,
    query,
  });
  return { query, results, workspace: state.workspace };
}

export default function SearchPage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const t = useT();
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
            <span>{t("Search")}</span>
          </nav>
        }
        title={t("Search")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Deterministic PostgreSQL search. No model or embedding provider is required.")}
        </p>
      </PageHeader>

      <Card>
        <CardContent className="pt-4">
          <Form method="get" className="flex gap-2">
            <label className="sr-only" htmlFor="search-query">
              {t("Search workspace records")}
            </label>
            <input
              id="search-query"
              name="q"
              type="search"
              defaultValue={data.query}
              placeholder={t("Record text, title, locator, or ID")}
              className="min-w-0 flex-1 rounded-md px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
            >
              {t("Search")}
            </button>
          </Form>
        </CardContent>
      </Card>

      {data.query ? (
        <section>
          <h2 className="font-mono text-xs text-muted-foreground">
            {t("{count, plural, one {# result} other {# results}} for “{query}”", {
              count: data.results.length,
              query: data.query,
            })}
          </h2>
          {data.results.length ? (
            <ul className="mt-3 space-y-3">
              {data.results.map((result) => (
                <li key={result.id}>
                  <Card>
                    <CardContent className="pt-4">
                      <Link
                        to={`/${result.collection_handle}/${result.id}`}
                        className="text-sm font-semibold text-primary hover:underline"
                      >
                        {result.title}
                      </Link>
                      <p className="mt-1 line-clamp-3 whitespace-pre-line text-xs leading-5 text-muted-foreground">
                        {result.excerpt}
                      </p>
                      <p className="mt-2 font-mono text-[11px] text-muted-foreground">
                        {result.collection_handle} · {result.node_type} · {result.lifecycle} ·{" "}
                        {result.id}
                      </p>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm italic text-muted-foreground">{t("No matching records.")}</p>
          )}
        </section>
      ) : null}
    </PageMain>
  );
}
