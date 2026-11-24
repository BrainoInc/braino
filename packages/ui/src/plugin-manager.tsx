import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./card.js";
import { type LogoId, PluginLogo } from "./plugin-logo.js";

export interface UiLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "aria-current"> {
  to: string;
  "aria-current"?: "page";
}

export interface PluginManagerItem {
  id: string;
  brand: LogoId;
  name: string;
  description: string;
  capability: string;
  status: string;
  actionLabel: string;
  href: string;
}

export interface PluginManagerGroup {
  title: string;
  plugins: PluginManagerItem[];
}

export interface PluginManagerProps {
  LinkComponent: ComponentType<UiLinkProps>;
  breadcrumb?: ReactNode;
  title: string;
  description: string;
  readiness?: ReactNode;
  viewsLabel: string;
  views: Array<{ label: string; href: string; current: boolean }>;
  groups: PluginManagerGroup[];
  emptyLabel: string;
}

/** Provider-neutral plugin catalogue; products supply data, links, and translated copy. */
export function PluginManager({
  LinkComponent,
  breadcrumb,
  title,
  description,
  readiness,
  viewsLabel,
  views,
  groups,
  emptyLabel,
}: PluginManagerProps) {
  const hasPlugins = groups.some((group) => group.plugins.length > 0);
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {breadcrumb}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {readiness}
      <nav className="flex gap-2" aria-label={viewsLabel}>
        {views.map((view) => (
          <LinkComponent
            key={view.href}
            to={view.href}
            {...(view.current ? { "aria-current": "page" as const } : {})}
            className="neu-button rounded-md px-4 py-2 text-sm font-semibold"
          >
            {view.label}
          </LinkComponent>
        ))}
      </nav>
      {hasPlugins ? (
        groups.map((group) =>
          group.plugins.length > 0 ? (
            <section key={group.title} className="space-y-3">
              <h2 className="font-serif text-xl font-semibold">{group.title}</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {group.plugins.map((plugin) => (
                  <Card key={plugin.id} className="flex h-full flex-col">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <PluginLogo brand={plugin.brand} />
                          <div className="min-w-0">
                            <CardTitle>{plugin.name}</CardTitle>
                            <CardDescription>{plugin.description}</CardDescription>
                          </div>
                        </div>
                        <span className="rounded-full border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
                          {plugin.status}
                        </span>
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-1 flex-col justify-between gap-4">
                      <p className="neu-well self-start rounded-md px-2.5 py-1 text-xs">
                        {plugin.capability}
                      </p>
                      <LinkComponent
                        to={plugin.href}
                        className="neu-button self-start rounded-md px-4 py-2 text-sm font-semibold"
                      >
                        {plugin.actionLabel}
                      </LinkComponent>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ) : null,
        )
      ) : (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}
