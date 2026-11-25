import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AgentSidebar } from "../agent-sidebar";

const appCss = readFileSync(new URL("../../app.css", import.meta.url), "utf8");
const sharedCss = readFileSync(new URL("../../../../ui/styles.css", import.meta.url), "utf8");

function render(path = "/"): string {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [path] }, createElement(AgentSidebar)),
  );
}

describe("AgentSidebar", () => {
  it("is the persistent hosted-style rail rather than a separate page", () => {
    const html = render();

    expect(html).toContain("senor-braino-rail");
    expect(html).toContain("--senor-braino-current-width:320px");
    expect(html).toContain('id="senor-braino-question"');
    expect(html).not.toContain('href="/senor-braino"');
  });

  it("opens the rail collapsed on the workspace usage page", () => {
    expect(render("/workspaces/studio/usage")).toContain('data-collapsed="true"');
  });

  it("becomes the same overlay drawer as hosted Braino on narrow screens", () => {
    expect(appCss).toContain('@import "@braino/ui/styles.css"');
    expect(sharedCss).toContain('.senor-braino-rail:not([data-collapsed="true"])');
    expect(sharedCss).toContain("@media (min-width: 640px)");
    expect(sharedCss).toContain(".senor-braino-backdrop");
  });
});
