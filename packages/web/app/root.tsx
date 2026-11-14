import { withClient } from "@doco/db";
import {
  getSingleWorkspaceState,
  getWorkspaceModelPluginReadiness,
  getWorkspaceRole,
} from "@doco/host";
import { type Locale, SOURCE_LOCALE, localeDirection, localeFromRequest } from "@doco/shared/i18n";
import { I18nProvider, useT } from "@doco/shared/i18n/react";
import {
  Form,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { BrainoMark } from "~/components/braino-mark";
import { LanguageMenu } from "~/components/language-menu";
import { PageMain } from "~/components/page-main";
import { type CurrentUser, getCurrentUser } from "~/lib/current-user.server";
import { securityHeaders } from "~/lib/security-headers.server";
import { catalogs } from "~/locales/catalog";
import "./app.css";

interface RootData {
  locale: Locale;
  initialized: boolean;
  user: CurrentUser | null;
  isOwner: boolean;
  modelsReady: boolean;
}

export async function loader({ request }: { request: Request }): Promise<RootData> {
  const locale = localeFromRequest(request);
  await catalogs.load(locale);
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) {
    return { locale, initialized: false, user: null, isOwner: false, modelsReady: false };
  }
  const user = await getCurrentUser(request);
  const modelsReady = (
    await withClient((client) => getWorkspaceModelPluginReadiness(client, state.workspace.id))
  ).ready;
  return {
    locale,
    initialized: true,
    user,
    modelsReady,
    isOwner: user
      ? (await withClient((client) => getWorkspaceRole(client, state.workspace.id, user.id))) ===
        "owner"
      : false,
  };
}

export function links() {
  return [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }];
}

export function headers() {
  return securityHeaders;
}

export function Layout({ children }: { children: React.ReactNode }) {
  // The root loader's data is missing only when the root itself failed to load.
  const locale = (useRouteLoaderData("root") as RootData | undefined)?.locale ?? SOURCE_LOCALE;
  return (
    <html lang={locale} dir={localeDirection(locale)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        <I18nProvider locale={locale} catalog={catalogs.of(locale)}>
          {children}
        </I18nProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const data = useLoaderData() as RootData;
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader data={data} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function SiteHeader({ data }: { data: RootData }) {
  const t = useT();
  return (
    <header className="h-14 border-b border-border bg-card">
      <div className="flex h-full w-full items-center gap-6 px-6">
        <Link
          to="/"
          className="inline-flex items-center hover:opacity-80"
          aria-label={t("Braino home")}
        >
          <BrainoMark height={28} />
        </Link>
        {data.user && data.modelsReady ? (
          <Form
            method="get"
            action="/search"
            className="ms-auto hidden min-w-0 max-w-md flex-1 sm:flex"
          >
            <label className="sr-only" htmlFor="workspace-search">
              {t("Search workspace records")}
            </label>
            <input
              id="workspace-search"
              name="q"
              type="search"
              placeholder={t("Search workspace")}
              className="min-w-0 flex-1 rounded-s-md px-3 py-1.5 text-xs"
            />
            <button
              type="submit"
              className="neu-button rounded-e-md px-3 py-1.5 text-xs font-semibold"
            >
              {t("Search")}
            </button>
          </Form>
        ) : null}
        <div className={`${data.user ? "" : "ms-auto"} flex shrink-0 items-center gap-2 text-xs`}>
          <LanguageMenu />
          {data.user ? (
            <>
              {data.isOwner ? (
                <Link to="/admin" className="neu-button rounded-md px-2.5 py-1.5 font-semibold">
                  {t("Admin")}
                </Link>
              ) : null}
              {data.modelsReady ? (
                <>
                  <Link to="/times" className="neu-button rounded-md px-2.5 py-1.5 font-semibold">
                    {t("Times")}
                  </Link>
                  <Link
                    to="/"
                    className="neu-button neu-pressed rounded-md px-2.5 py-1.5 font-semibold"
                  >
                    {t("Workspace")}
                  </Link>
                </>
              ) : null}
              <span className="font-mono text-muted-foreground">@{data.user.username}</span>
              <Form method="post" action="/">
                <input type="hidden" name="intent" value="signout" />
                <button type="submit" className="neu-button rounded-md px-2.5 py-1.5 font-semibold">
                  {t("Sign out everywhere")}
                </button>
              </Form>
            </>
          ) : data.initialized ? (
            <Link to="/" className="neu-button neu-pressed rounded-md px-3 py-1.5 font-semibold">
              {t("Sign in")}
            </Link>
          ) : null}
        </div>
      </div>
    </header>
  );
}

export function ErrorBoundary() {
  const t = useT();
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error)
    ? t(error.statusText)
    : error instanceof Error
      ? t(error.message)
      : t("Unexpected error");
  return (
    <PageMain className="space-y-4 py-10">
      <p className="font-mono text-xs text-muted-foreground">{"Braino"}</p>
      <div className="neu-surface rounded-lg bg-card p-5">
        <h1 className="text-2xl font-semibold text-destructive">{status}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <Link
          className="neu-button mt-4 inline-flex rounded-md px-4 py-2 text-sm font-semibold"
          to="/"
        >
          {t("Return home")}
        </Link>
      </div>
    </PageMain>
  );
}
