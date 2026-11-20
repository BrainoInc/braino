import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AgentSidebar } from "../agent-sidebar";

const appCss = readFileSync(new URL("../../app.css", import.meta.url), "utf8");

function render(): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(AgentSidebar)));
}

describe("AgentSidebar", () => {
  it("is the persistent hosted-style rail rather than a separate page", () => {
    const html = render();

    expect(html).toContain("senor-doco-rail");
    expect(html).toContain("--senor-doco-current-width:320px");
    expect(html).toContain('id="senor-braino-question"');
    expect(html).not.toContain('href="/senor-braino"');
  });

  it("becomes the same overlay drawer as hosted Braino on narrow screens", () => {
    expect(appCss).toContain('.senor-doco-rail:not([data-collapsed="true"])');
    expect(appCss).toContain("@media (min-width: 640px)");
    expect(appCss).toContain(".senor-doco-backdrop");
  });
});
