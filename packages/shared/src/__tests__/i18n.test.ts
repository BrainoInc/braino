import { describe, expect, it } from "vitest";
import {
  LOCALES,
  createTranslator,
  localeCookie,
  localeDirection,
  localeFromRequest,
  msg,
  negotiateLocale,
} from "../i18n.js";

describe("locales", () => {
  it("offers English and the ten languages Braino is translated into", () => {
    expect(LOCALES.map((locale) => locale.code)).toEqual([
      "en",
      "es",
      "zh-CN",
      "ja",
      "de",
      "fr",
      "pt-BR",
      "ko",
      "ru",
      "hi",
      "ar",
    ]);
  });

  it("lays out Arabic right to left and every other language left to right", () => {
    expect(localeDirection("ar")).toBe("rtl");
    for (const { code } of LOCALES.filter((locale) => locale.code !== "ar")) {
      expect(localeDirection(code)).toBe("ltr");
    }
  });
});

describe("negotiateLocale", () => {
  it("prefers the language asked for, then the saved one, then the browser's", () => {
    expect(negotiateLocale({ requested: "ja", saved: "de", acceptLanguage: "fr" })).toBe("ja");
    expect(negotiateLocale({ requested: null, saved: "de", acceptLanguage: "fr" })).toBe("de");
    expect(negotiateLocale({ acceptLanguage: "fr" })).toBe("fr");
  });

  it("skips a language Braino has no translation for", () => {
    expect(negotiateLocale({ requested: "tlh", saved: "xx", acceptLanguage: "fr" })).toBe("fr");
  });

  it("reads the browser's languages in order of preference", () => {
    expect(negotiateLocale({ acceptLanguage: "nl;q=0.9, ko;q=0.8, es;q=0.85" })).toBe("es");
  });

  it("matches a regional variant to the translation of its language", () => {
    expect(negotiateLocale({ acceptLanguage: "pt-PT" })).toBe("pt-BR");
    expect(negotiateLocale({ acceptLanguage: "zh-TW" })).toBe("zh-CN");
    expect(negotiateLocale({ acceptLanguage: "es-419, en;q=0.5" })).toBe("es");
    expect(negotiateLocale({ acceptLanguage: "EN-gb" })).toBe("en");
  });

  it("falls back to English", () => {
    expect(negotiateLocale({})).toBe("en");
    expect(negotiateLocale({ acceptLanguage: "nl, sv;q=0.5" })).toBe("en");
  });
});

describe("localeFromRequest", () => {
  it("reads ?lang, then the saved cookie, then Accept-Language", () => {
    const headers = { cookie: "a=1; braino_locale=de; b=2", "accept-language": "fr" };
    expect(localeFromRequest(new Request("https://braino.test/x?lang=ko", { headers }))).toBe("ko");
    expect(localeFromRequest(new Request("https://braino.test/x", { headers }))).toBe("de");
    expect(
      localeFromRequest(
        new Request("https://braino.test/x", { headers: { "accept-language": "fr" } }),
      ),
    ).toBe("fr");
  });

  it("saves a language for a year in a cookie the page's own scripts can't read", () => {
    expect(localeCookie("pt-BR")).toBe(
      "braino_locale=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax; HttpOnly",
    );
  });
});

describe("createTranslator", () => {
  it("returns the English text when the catalog has no translation", () => {
    const t = createTranslator("es", {});
    expect(t("Sign in")).toBe("Sign in");
    expect(t.locale).toBe("es");
  });

  it("translates and fills in values", () => {
    const t = createTranslator("es", { "Signed in as {name}": "Sesión iniciada como {name}" });
    expect(t("Signed in as {name}", { name: "Ada" })).toBe("Sesión iniciada como Ada");
  });

  it("formats a number the way the language writes it and leaves text alone", () => {
    expect(
      createTranslator("de", {})("{count} records in {year}", { count: 12345, year: "2026" }),
    ).toBe("12.345 records in 2026");
  });

  it("picks the plural form the language calls for", () => {
    const source = "{count, plural, one {# result} other {# results}}";
    const en = createTranslator("en", {});
    expect(en(source, { count: 1 })).toBe("1 result");
    expect(en(source, { count: 0 })).toBe("0 results");

    const ru = createTranslator("ru", {
      [source]:
        "{count, plural, one {# результат} few {# результата} many {# результатов} other {# результата}}",
    });
    expect(ru(source, { count: 1 })).toBe("1 результат");
    expect(ru(source, { count: 3 })).toBe("3 результата");
    expect(ru(source, { count: 5 })).toBe("5 результатов");
    expect(ru(source, { count: 21 })).toBe("21 результат");
  });

  it("lets an exact number override the plural form", () => {
    const t = createTranslator("en", {});
    const source = "{count, plural, =0 {No records} one {# record} other {# records}}";
    expect(t(source, { count: 0 })).toBe("No records");
    expect(t(source, { count: 2 })).toBe("2 records");
  });

  it("selects a branch by a named value", () => {
    const t = createTranslator("en", {});
    const source = "{role, select, owner {Owns the workspace} other {Member of {name}}}";
    expect(t(source, { role: "owner", name: "acme" })).toBe("Owns the workspace");
    expect(t(source, { role: "writer", name: "acme" })).toBe("Member of acme");
  });

  it("wraps the marked part of a sentence, wherever the translation puts it", () => {
    const source = "Read the <guide>operations guide</guide> before {when}.";
    const t = createTranslator("de", {
      [source]: "Lies vor {when} den <guide>Betriebsleitfaden</guide>.",
    });
    expect(
      t.rich(source, {
        when: "upgrading",
        guide: (children) => ({ link: children }),
      }),
    ).toEqual(["Lies vor upgrading den ", { link: ["Betriebsleitfaden"] }, "."]);
  });

  it("keeps angle brackets that aren't a marked part as plain text", () => {
    const t = createTranslator("en", {});
    expect(t("Open /<collection-handle>/api when a < b")).toBe(
      "Open /<collection-handle>/api when a < b",
    );
  });

  it("looks up text that only exists at run time, such as an error from the server", () => {
    const t = createTranslator("fr", { "Unknown action.": "Action inconnue." });
    const error: string = msg("Unknown action.");
    expect(t(error)).toBe("Action inconnue.");
    expect(t("Collection acme was not found.")).toBe("Collection acme was not found.");
    expect(t("Unexpected token } in JSON at {")).toBe("Unexpected token } in JSON at {");
  });

  it("refuses a sentence whose value is missing", () => {
    const t = createTranslator("en", {});
    expect(() => t("Signed in as {name}", {})).toThrow(/name/);
    expect(() => t.rich("Read the <guide>guide</guide>.", {})).toThrow(/guide/);
    expect(() => t("Read the <guide>guide</guide>.", {})).toThrow(/rich/);
  });
});
