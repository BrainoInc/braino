import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname);
const appCss = readFileSync(resolve(app, "app.css"), "utf8");
const css = readFileSync(resolve(app, "../../ui/styles.css"), "utf8");
const flatCss = css.replace(/\s+/g, " ");
const root = readFileSync(resolve(app, "root.tsx"), "utf8");
const home = readFileSync(resolve(app, "routes/_index.tsx"), "utf8");
const card = readFileSync(resolve(app, "../../ui/src/card.tsx"), "utf8");
const mark = readFileSync(resolve(app, "../../ui/src/braino-mark.tsx"), "utf8");
const appHeader = readFileSync(resolve(app, "../../ui/src/app-header.tsx"), "utf8");
const siteHeader = readFileSync(resolve(app, "components/site-header.tsx"), "utf8");
const languageMenu = readFileSync(resolve(app, "components/language-menu.tsx"), "utf8");

describe("Braino's design language", () => {
  it("uses the same typography and one-clay color tokens as Braino", () => {
    expect(appCss).toContain("Merriweather:ital,wght@0,300..900;1,300..900");
    expect(flatCss).toContain('--font-serif: "Merriweather", Georgia');
    expect(flatCss).toContain('--font-mono: "Ubuntu Mono"');
    expect(flatCss).toMatch(/--color-background:\s*light-dark\(\s*oklch\(0\.961 0\.0054 95\.1\)/);
    expect(flatCss).toMatch(/--color-primary:\s*light-dark\(\s*oklch\(0\.54 0\.17 324\)/);
  });

  it("keeps surfaces grooved, fields inset, and only clickables raised", () => {
    expect(css).toMatch(/\.neu-surface\s*\{[^}]*box-shadow:\s*var\(--neu-groove\)/s);
    expect(css).toMatch(/\.neu-well\s*\{[^}]*box-shadow:\s*var\(--neu-inset\)/s);
    expect(css).toMatch(/\.neu-button\s*\{[^}]*box-shadow:\s*var\(--neu-key\)/s);
    expect(css).toMatch(/input:not\([^}]*box-shadow:\s*var\(--neu-inset\)/s);
  });

  it("uses Braino's real mark, site header, and workspace page primitives", () => {
    expect(root).toContain('from "~/components/site-header"');
    expect(root).toContain("<SiteHeader");
    expect(siteHeader).toContain('from "@braino/ui"');
    expect(siteHeader).toContain("<BrainoMark height={28}");
    expect(appHeader).toContain("h-14 border-b border-border bg-card");
    expect(appCss).toContain('@import "@braino/ui/styles.css"');
    expect(mark).toContain("braino-mark-glyph-motion");
    expect(mark).toContain("braino-mark-spark-lg");
    expect(mark).toContain('className="fill-primary"');
    expect(mark).not.toContain('fill="#9945A1"');
    expect(mark).not.toContain("<img");
    expect(languageMenu).toContain('from "country-flag-icons/react/3x2"');
    expect(languageMenu).toContain("<Flag locale={t.locale}");
    expect(languageMenu).not.toContain("<Languages");
    expect(home).toContain("<NarrowPageMain");
    expect(home).toContain("<PageMain");
    expect(home).toContain("<Card");
    expect(home).toContain("neu-button");
    expect(card).toContain("neu-surface");
    expect(home).not.toContain('className="panel"');
    expect(home).not.toContain('className="card"');
  });
});
