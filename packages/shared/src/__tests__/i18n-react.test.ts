import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider, useT } from "../i18n-react.js";

function Greeting() {
  const t = useT();
  return createElement(
    "p",
    { title: t("Sign in"), lang: t.locale },
    t.rich("Hello <b>{name}</b>, read the <guide>guide</guide>.", {
      name: "Ada",
      b: (children) => createElement("b", null, children),
      guide: (children) => createElement("a", { href: "/guide" }, children),
    }),
  );
}

describe("useT", () => {
  it("shows English when no language is provided", () => {
    expect(renderToStaticMarkup(createElement(Greeting))).toBe(
      '<p title="Sign in" lang="en">Hello <b>Ada</b>, read the <a href="/guide">guide</a>.</p>',
    );
  });

  it("shows the provided language", () => {
    const catalog = {
      "Sign in": "Iniciar sesión",
      "Hello <b>{name}</b>, read the <guide>guide</guide>.":
        "Lee la <guide>guía</guide>, <b>{name}</b>.",
    };
    expect(
      renderToStaticMarkup(
        createElement(I18nProvider, { locale: "es", catalog }, createElement(Greeting)),
      ),
    ).toBe('<p title="Iniciar sesión" lang="es">Lee la <a href="/guide">guía</a>, <b>Ada</b>.</p>');
  });

  it("asks React for no keys, so rendering a sentence logs nothing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    renderToStaticMarkup(createElement(Greeting));
    const logged = error.mock.calls;
    error.mockRestore();
    expect(logged).toEqual([]);
  });
});
