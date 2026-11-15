import type { ReactTranslator } from "@doco/shared/i18n/react";
import { useT } from "@doco/shared/i18n/react";
import { ArrowLeft, Check, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { ModelKind, ModelPluginEntry } from "~/lib/model-plugin-catalog";

export function modelTitle(t: ReactTranslator, kind: ModelKind): string {
  return kind === "chat" ? t("Chat model") : t("Embedding model");
}

/** One sentence on where a plugin runs its models, from what its manifest may reach. */
export function pluginTagline(t: ReactTranslator, plugin: ModelPluginEntry): string {
  if (plugin.local) return t("Runs models on this server.");
  const host = plugin.networkHosts.join(", ");
  return plugin.requiredSecrets.length > 0
    ? t("Runs models at {host}, with its own key.", { host })
    : t("Runs models at {host}.", { host });
}

/** Bundled plugins in Braino's own namespace are published by Braino. */
export function publishedByBraino(plugin: ModelPluginEntry): boolean {
  return plugin.id.startsWith("braino.");
}

/** A plugin's name, publisher, where it runs and its tagline, as one list row shows them. */
export function PluginSummary({ plugin }: { plugin: ModelPluginEntry }) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-base font-semibold">{plugin.name}</h3>
        {publishedByBraino(plugin) ? (
          <span className="text-xs text-muted-foreground">{t("By Braino")}</span>
        ) : null}
        <span className="font-mono text-[11px] text-muted-foreground">
          {plugin.local ? t("on this server") : t("cloud")}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">{pluginTagline(t, plugin)}</p>
    </>
  );
}

/** Braino › First run or Admin › Model setup › the screens below it. */
export function ModelSetupBreadcrumb({
  firstRun,
  trail = [],
}: {
  firstRun: boolean;
  trail?: readonly { label: string; to?: string }[];
}) {
  const t = useT();
  const crumbs = [
    firstRun ? { label: t("First run") } : { label: t("Admin"), to: "/admin" },
    { label: t("Model setup"), to: "/admin/models" },
    ...trail,
  ];
  return (
    <nav className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        {"Braino"}
      </Link>
      {crumbs.map((crumb, index) => (
        <span key={crumb.label} className="flex items-center gap-1.5">
          <span aria-hidden>›</span>
          {crumb.to && index < crumbs.length - 1 ? (
            <Link to={crumb.to} className="hover:underline">
              {crumb.label}
            </Link>
          ) : (
            <span>{crumb.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="neu-button neu-small inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold"
    >
      <ArrowLeft aria-hidden className="size-3.5 rtl:rotate-180" />
      {children}
    </Link>
  );
}

/** One line of status: a tick when things are in order, a warning when they need attention. */
export function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? Check : TriangleAlert;
  return (
    <div className="flex items-start gap-2 text-xs">
      <Icon
        aria-hidden
        className={`mt-0.5 size-4 shrink-0 ${ok ? "text-primary" : "text-destructive"}`}
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
