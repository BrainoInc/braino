import { createElement } from "react";

import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { SiteHeader } from "../site-header";

vi.mock("~/components/braino-mark", () => ({
  BrainoMark: () => createElement("span", null, "Braino"),
}));

vi.mock("~/components/version-pill", () => ({
  VersionPill: () => createElement("span", null, "Private beta test"),
}));

vi.mock("~/components/theme-menu", () => ({
  ThemeMenu: () => createElement("button", { type: "button" }, "Theme"),
}));

vi.mock("~/components/language-menu", () => ({
  LanguageMenu: () => createElement("button", { type: "button" }, "Language"),
}));

const user = {
  id: "user_alice",
  email: "alice@example.com",
  username: "alice",
  name: "Alice Rojas",
};

function render(path = "/", isOwner = true): string {
  const router = createMemoryRouter(
    [{ path: "*", element: createElement(SiteHeader, { user, isOwner }) }],
    { initialEntries: [path] },
  );
  return renderToStaticMarkup(createElement(RouterProvider, { router }));
}

describe("SiteHeader", () => {
  it("uses the hosted Braino app-bar structure with self-hosted destinations", () => {
    const markup = render();

    expect(markup).toContain("Private beta test");
    expect(markup).toMatch(/<a[^>]*href="\/"[^>]*>Workspace<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/collaborators"[^>]*>Collaborators<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/mcp-tokens"[^>]*>Agent access<\/a>/);
    expect(markup).toMatch(/<a[^>]*href="\/admin"[^>]*>Admin<\/a>/);
    expect(markup).toMatch(
      /<a[^>]*class="[^"]*neu-button[^"]*max-w-48 truncate[^"]*"[^>]*href="\/collaborators"[^>]*>Alice Rojas<\/a>/,
    );
    expect(markup).not.toContain("@alice");
    expect(markup).toContain(">Sign out</button>");
    expect(markup).not.toContain("Sign out everywhere");
    expect(markup).not.toContain("Search workspace");
    expect(markup).not.toContain(">Times</a>");
  });

  it("keeps navigation in the hosted-style menu until the row has room", () => {
    const markup = render();
    const navClass = markup.match(/<nav class="([^"]*)"/)?.[1] ?? "";
    expect(navClass).toContain("hidden");
    expect(navClass).toContain("xl:flex");
    expect(markup).toContain('aria-label="Open navigation menu"');
    expect(markup).toContain("xl:hidden");
  });

  it("marks only the current top-level destination as active", () => {
    const workspace = render("/");
    const admin = render("/admin");
    expect(workspace).toMatch(/class="[^"]*neu-pressed[^"]*" href="\/"[^>]*>Workspace<\/a>/);
    expect(admin).not.toMatch(/class="[^"]*neu-pressed[^"]*" href="\/"[^>]*>Workspace<\/a>/);
    expect(admin).toMatch(/class="[^"]*neu-pressed[^"]*" href="\/admin"[^>]*>Admin<\/a>/);
  });
});
