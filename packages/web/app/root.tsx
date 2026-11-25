import { withClient } from "@braino/db";
import { getSingleWorkspaceState, getWorkspaceRole } from "@braino/host";
import { getWorkspaceModelPluginReadiness } from "@braino/host/model-plugins";
import {
  type Locale,
  SOURCE_LOCALE,
  localeDirection,
  localeFromRequest,
} from "@braino/shared/i18n";
import { I18nProvider, useT } from "@braino/shared/i18n/react";
import { PageMain } from "@braino/ui";
import {
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
import { AgentSidebar } from "~/components/agent-sidebar";
import { SiteHeader } from "~/components/site-header";
import { type CurrentUser, getCurrentUser } from "~/lib/current-user.server";
import { securityHeaders } from "~/lib/security-headers.server";
import { type Theme, themeFromRequest } from "~/lib/theme";
import { catalogs } from "~/locales/catalog";
import "./app.css";

interface RootData {
  locale: Locale;
  initialized: boolean;
  user: CurrentUser | null;
  isOwner: boolean;
  modelsReady: boolean;
  theme: Theme;
}

export async function loader({ request }: { request: Request }): Promise<RootData> {
  const locale = localeFromRequest(request);
  const theme = themeFromRequest(request);
  await catalogs.load(locale);
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) {
    return { locale, theme, initialized: false, user: null, isOwner: false, modelsReady: false };
  }
  const user = await getCurrentUser(request);
  const modelsReady = (
    await withClient((client) => getWorkspaceModelPluginReadiness(client, state.workspace.id))
  ).ready;
  return {
    locale,
    theme,
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
  const root = useRouteLoaderData("root") as RootData | undefined;
  const locale = root?.locale ?? SOURCE_LOCALE;
  return (
    <html lang={locale} dir={localeDirection(locale)} data-theme={root?.theme ?? "auto"}>
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
      <SiteHeader user={data.user} isOwner={data.isOwner} initialized={data.initialized} />
      <div className="braino-shell-body flex min-h-0 flex-1">
        {data.user && data.modelsReady ? <AgentSidebar /> : null}
        <main className="braino-shell-main min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
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
