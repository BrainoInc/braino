import {
  type Catalog,
  type Locale,
  SOURCE_LOCALE,
  type Translator,
  createTranslator,
  localeFromRequest,
} from "@doco/shared/i18n";

// One catalog per language beside this file, each fetched only when a reader asks for it.
const files = import.meta.glob<Catalog>("./*.json", { import: "default" });
const loaded = new Map<Locale, Catalog>([[SOURCE_LOCALE, {}]]);

/** Loads a language. The server awaits it for each request; the browser before it hydrates. */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  let catalog = loaded.get(locale);
  if (!catalog) {
    catalog = (await files[`./${locale}.json`]?.()) ?? {};
    loaded.set(locale, catalog);
  }
  return catalog;
}

/** A language `loadCatalog` has already loaded: the reader's, wherever a page is rendering. */
export function catalogOf(locale: Locale): Catalog {
  return loaded.get(locale) ?? {};
}

/** The translator for a loader or an action: `const t = await requestTranslator(request)`. */
export async function requestTranslator(request: Request): Promise<Translator> {
  const locale = localeFromRequest(request);
  return createTranslator(locale, await loadCatalog(locale));
}

/** The translator for a route's `meta`: `const t = metaTranslator(matches)`. */
export function metaTranslator(
  matches: readonly ({ id: string; data?: unknown } | undefined)[],
): Translator {
  const root = matches.find((match) => match?.id === "root")?.data as
    | { locale?: Locale }
    | undefined;
  const locale = root?.locale ?? SOURCE_LOCALE;
  return createTranslator(locale, catalogOf(locale));
}
