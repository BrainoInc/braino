import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AppHeader,
  AppHeaderMobilePanel,
  BrainoMark,
  Card,
  PageMain,
  PluginManager,
  type UiLinkProps,
} from "../index";

function Link({ to, children, ...props }: UiLinkProps) {
  return (
    <a href={to} {...props}>
      {children}
    </a>
  );
}

describe("the shared Braino UI", () => {
  it("owns the application shell and responsive navigation", () => {
    const markup = renderToStaticMarkup(
      <AppHeader
        home={<a href="/">Home</a>}
        navigation={({ onNavigate }) => (
          <a href="/plugins" onClick={onNavigate}>
            Plugins
          </a>
        )}
        utilities={<button type="button">Theme</button>}
        menuLabel="Open navigation menu"
        navigationLabel="Navigation"
      />,
    );

    expect(markup).toContain("<header");
    expect(markup.match(/href="\/plugins"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="Open navigation menu"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("owns the common brand, card, and page-width primitives", () => {
    const markup = renderToStaticMarkup(
      <PageMain>
        <BrainoMark height={28} />
        <Card>Shared surface</Card>
      </PageMain>,
    );

    expect(markup).toContain("max-w-6xl");
    expect(markup).toContain("braino-mark");
    expect(markup).toContain("neu-surface");
  });

  it("keeps mobile navigation above page dialogs", () => {
    const markup = renderToStaticMarkup(
      <AppHeaderMobilePanel navigationLabel="Navigation">Links</AppHeaderMobilePanel>,
    );
    expect(markup).toContain("z-[130]");
    expect(markup).toContain('aria-label="Navigation"');
  });

  it("renders one provider-neutral plugin manager", () => {
    const markup = renderToStaticMarkup(
      <PluginManager
        LinkComponent={Link}
        title="Plugins"
        description="Install and manage plugins."
        viewsLabel="Plugin views"
        views={[
          { label: "Browse", href: "/plugins", current: true },
          {
            label: "Installed",
            href: "/plugins?view=installed",
            current: false,
          },
        ]}
        groups={[
          {
            title: "Chat",
            plugins: [
              {
                id: "openai-chat",
                brand: "openai",
                name: "OpenAI Chat",
                description: "Use an OpenAI model.",
                capability: "Chat",
                status: "Available",
                actionLabel: "View plugin",
                href: "/plugins/openai-chat",
              },
            ],
          },
        ]}
        emptyLabel="No plugins are installed yet."
      />,
    );

    expect(markup).toContain("OpenAI Chat");
    expect(markup).toContain("View plugin");
    expect(markup).toContain("OpenAI");
  });
});
