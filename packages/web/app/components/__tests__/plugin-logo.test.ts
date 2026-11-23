import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LOGOS } from "~/lib/logos";
import { PluginLogo } from "../plugin-logo";

describe("PluginLogo", () => {
  it.each([
    ["ollama-chat", LOGOS.ollama],
    ["ollama-embedding", LOGOS.ollama],
    ["openai-chat", LOGOS.openai],
    ["openai-embedding", LOGOS.openai],
    ["slack", LOGOS.slack],
    ["resend", LOGOS.resend],
  ] as const)("draws the provider mark for %s", (pluginId, logo) => {
    const html = renderToStaticMarkup(createElement(PluginLogo, { pluginId }));

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(`background-color:${logo.color}`);
    expect(html).toContain(`d="${logo.path}"`);
  });
});
