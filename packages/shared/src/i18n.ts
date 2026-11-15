/**
 * Translation of Braino's interface.
 *
 * The English text in the source is the key: `t("Sign in")` shows "Sign in"
 * in English and looks the same words up in the reader's catalog otherwise,
 * so English needs no catalog and a missing translation reads as English.
 *
 * A sentence can carry values, plurals, choices and marked parts:
 *
 *   t("Signed in as {name}", { name })
 *   t("{count, plural, one {# record} other {# records}}", { count })
 *   t("{role, select, owner {Owner} other {Member}}", { role })
 *   t("{rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", { rank })
 *   t.rich("Read the <guide>operations guide</guide>.", { guide: (children) => … })
 *
 * A number is written the way the language writes it; pass text to show a
 * value untouched. `i18n-catalog.ts` checks every catalog against the source.
 */

export const LOCALES = [
  { code: "en", name: "English", direction: "ltr" },
  { code: "es", name: "Español", direction: "ltr" },
  { code: "zh-CN", name: "简体中文", direction: "ltr" },
  { code: "ja", name: "日本語", direction: "ltr" },
  { code: "de", name: "Deutsch", direction: "ltr" },
  { code: "fr", name: "Français", direction: "ltr" },
  { code: "pt-BR", name: "Português (Brasil)", direction: "ltr" },
  { code: "ko", name: "한국어", direction: "ltr" },
  { code: "ru", name: "Русский", direction: "ltr" },
  { code: "hi", name: "हिन्दी", direction: "ltr" },
  { code: "ar", name: "العربية", direction: "rtl" },
] as const;

export type Locale = (typeof LOCALES)[number]["code"];

/** The language the source is written in; it has no catalog. */
export const SOURCE_LOCALE: Locale = "en";

/** A language's translations: English text → the same sentence translated. */
export type Catalog = Readonly<Record<string, string>>;

export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return LOCALES.find((candidate) => candidate.code === locale)?.direction ?? "ltr";
}

function matchLocale(tag: string | null | undefined): Locale | null {
  const wanted = tag?.trim().toLowerCase();
  if (!wanted) return null;
  const exact = LOCALES.find((locale) => locale.code.toLowerCase() === wanted);
  if (exact) return exact.code;
  const language = wanted.split("-")[0];
  return (
    LOCALES.find((locale) => locale.code.toLowerCase().split("-")[0] === language)?.code ?? null
  );
}

function acceptedLanguages(header: string | null | undefined): string[] {
  return (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...parameters] = part.trim().split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((p) => p.startsWith("q="));
      const weight = quality ? Number(quality.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.tag);
}

/** The language to show: the one asked for, else the saved one, else the browser's, else English. */
export function negotiateLocale(input: {
  requested?: string | null | undefined;
  saved?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}): Locale {
  for (const tag of [input.requested, input.saved, ...acceptedLanguages(input.acceptLanguage)]) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }
  return SOURCE_LOCALE;
}

/**
 * `?lang=<code>` on any page shows it in that language. The browser then saves
 * the choice with `document.cookie = localeCookie(locale)`, so later pages
 * need no parameter.
 */
export const LOCALE_PARAM = "lang";
const LOCALE_COOKIE = "braino_locale";

export function localeFromRequest(request: Request): Locale {
  const saved = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim().split("="))
    .find(([name]) => name === LOCALE_COOKIE)?.[1];
  return negotiateLocale({
    requested: new URL(request.url).searchParams.get(LOCALE_PARAM),
    saved,
    acceptLanguage: request.headers.get("accept-language"),
  });
}

export function localeCookie(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/**
 * Marks English text for translation where no translator is at hand (a
 * constant, an error a server function returns). Show it with `t(text)`.
 */
export function msg(text: string): string {
  return text;
}

export type MessageNode =
  | string
  | { kind: "value"; name: string }
  | { kind: "number" }
  | {
      kind: "plural" | "selectordinal" | "select";
      name: string;
      options: Map<string, MessageNode[]>;
    }
  | { kind: "tag"; name: string; children: MessageNode[] };

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const OPEN_TAG = /<([a-z][a-z0-9]*)>/y;

/** Parses a sentence; throws on one that is malformed. */
export function parseMessage(message: string): MessageNode[] {
  let at = 0;

  function fail(problem: string): never {
    throw new Error(`${problem} at ${at} in "${message}"`);
  }

  function skipSpace(): void {
    while (/\s/.test(message[at] ?? "")) at += 1;
  }

  function name(): string {
    skipSpace();
    NAME.lastIndex = at;
    const found = NAME.exec(message);
    if (!found) fail("Expected a name");
    at = NAME.lastIndex;
    skipSpace();
    return found[0];
  }

  function options(inPlural: boolean): Map<string, MessageNode[]> {
    const found = new Map<string, MessageNode[]>();
    skipSpace();
    while (message[at] !== "}") {
      const start = at;
      while (at < message.length && !/[\s{}]/.test(message[at] ?? "")) at += 1;
      const key = message.slice(start, at);
      skipSpace();
      if (!key || message[at] !== "{") fail("Expected an option");
      at += 1;
      found.set(key, nodes("}", inPlural));
      at += 1;
      skipSpace();
      if (at >= message.length) fail("Unclosed {");
    }
    if (!found.has("other")) fail('Missing the "other" option');
    return found;
  }

  function argument(inPlural: boolean): MessageNode {
    at += 1;
    const argumentName = name();
    if (message[at] === "}") {
      at += 1;
      return { kind: "value", name: argumentName };
    }
    if (message[at] !== ",") fail("Expected } or ,");
    at += 1;
    const kind = name();
    if (kind !== "plural" && kind !== "selectordinal" && kind !== "select") {
      fail("Expected plural, selectordinal or select");
    }
    if (message[at] !== ",") fail("Expected ,");
    at += 1;
    const found = options(inPlural || kind !== "select");
    at += 1;
    return { kind, name: argumentName, options: found };
  }

  // "#" stands for the number only inside a plural's options.
  function nodes(until: "}" | "tag" | "end", inPlural = false): MessageNode[] {
    const found: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text) found.push(text);
      text = "";
    };
    while (at < message.length) {
      const character = message[at];
      if (character === "}") {
        if (until !== "}") fail("Unexpected }");
        flush();
        return found;
      }
      if (character === "{") {
        flush();
        found.push(argument(inPlural));
        continue;
      }
      if (character === "#" && inPlural) {
        flush();
        found.push({ kind: "number" });
        at += 1;
        continue;
      }
      if (character === "<") {
        if (until === "tag" && message.startsWith("</", at)) {
          flush();
          return found;
        }
        OPEN_TAG.lastIndex = at;
        const tag = OPEN_TAG.exec(message)?.[1];
        const close = tag ? `</${tag}>` : "";
        if (tag && message.indexOf(close, OPEN_TAG.lastIndex) !== -1) {
          flush();
          at = OPEN_TAG.lastIndex;
          const children = nodes("tag", inPlural);
          if (!message.startsWith(close, at)) fail(`Expected ${close}`);
          at += close.length;
          found.push({ kind: "tag", name: tag, children });
          continue;
        }
      }
      text += character;
      at += 1;
    }
    if (until !== "end") fail(until === "}" ? "Unclosed {" : "Unclosed tag");
    flush();
    return found;
  }

  return nodes("end");
}

type TextValue = string | number;

export interface Translator {
  /** The sentence in the reader's language. Without `values` an unknown text is returned as is. */
  (source: string, values?: Readonly<Record<string, TextValue>>): string;
  /** The same, with each `<name>…</name>` part handed to `values.name` to wrap. */
  rich<Part>(
    source: string,
    values: Readonly<Record<string, TextValue | ((children: (string | Part)[]) => Part)>>,
  ): (string | Part)[];
  readonly locale: Locale;
}

export function createTranslator(locale: Locale, catalog: Catalog): Translator {
  const parsed = new Map<string, MessageNode[]>();
  const numbers = new Intl.NumberFormat(locale);
  const plurals = new Intl.PluralRules(locale);
  const ordinals = new Intl.PluralRules(locale, { type: "ordinal" });

  function nodesOf(message: string): MessageNode[] {
    let nodes = parsed.get(message);
    if (!nodes) {
      nodes = parseMessage(message);
      parsed.set(message, nodes);
    }
    return nodes;
  }

  function render<Part>(
    nodes: MessageNode[],
    values: Readonly<Record<string, unknown>>,
    message: string,
    rich: boolean,
    pluralValue?: number,
  ): (string | Part)[] {
    const out: (string | Part)[] = [];
    const push = (part: string | Part) => {
      const last = out.length - 1;
      if (typeof part === "string" && typeof out[last] === "string") out[last] += part;
      else out.push(part);
    };
    const given = (name: string): unknown => {
      if (!(name in values)) throw new Error(`"${message}" needs a value for ${name}`);
      return values[name];
    };
    for (const node of nodes) {
      if (typeof node === "string") push(node);
      else if (node.kind === "number") push(numbers.format(pluralValue ?? 0));
      else if (node.kind === "value") {
        const value = given(node.name);
        push(typeof value === "number" ? numbers.format(value) : String(value));
      } else if (node.kind === "tag") {
        if (!rich) throw new Error(`"${message}" marks a part; show it with t.rich`);
        const wrap = given(node.name);
        if (typeof wrap !== "function") throw new Error(`"${message}" needs ${node.name} to wrap`);
        push(wrap(render<Part>(node.children, values, message, rich, pluralValue)) as Part);
      } else {
        const value = given(node.name);
        const rules = node.kind === "plural" ? plurals : ordinals;
        const branch =
          node.kind === "select"
            ? node.options.get(String(value))
            : (node.options.get(`=${value}`) ?? node.options.get(rules.select(Number(value))));
        const chosen = branch ?? node.options.get("other") ?? [];
        const count = node.kind === "select" ? pluralValue : Number(value);
        for (const part of render<Part>(chosen, values, message, rich, count)) push(part);
      }
    }
    return out;
  }

  const translate = (source: string, values?: Readonly<Record<string, TextValue>>): string => {
    const message = catalog[source];
    if (!values && !message) return source;
    const text = message || source;
    return render<never>(nodesOf(text), values ?? {}, text, false).join("");
  };

  return Object.assign(translate, {
    locale,
    rich<Part>(
      source: string,
      values: Readonly<Record<string, TextValue | ((children: (string | Part)[]) => Part)>>,
    ): (string | Part)[] {
      const text = catalog[source] || source;
      return render<Part>(nodesOf(text), values, text, true);
    },
  });
}

/**
 * An app's catalogs, each loaded the first time a reader asks for its language.
 * An app makes one beside its catalog files:
 *
 *   export const catalogs = catalogStore(import.meta.glob("./*.json", { import: "default" }));
 */
export function catalogStore(files: Readonly<Record<string, () => Promise<unknown>>>) {
  const loaded = new Map<Locale, Catalog>([[SOURCE_LOCALE, {}]]);

  /** Loads a language. The server awaits it for each request; the browser before it hydrates. */
  async function load(locale: Locale): Promise<Catalog> {
    let catalog = loaded.get(locale);
    if (!catalog) {
      catalog = ((await files[`./${locale}.json`]?.()) ?? {}) as Catalog;
      loaded.set(locale, catalog);
    }
    return catalog;
  }

  /** A language `load` has already loaded: the reader's, wherever a page is rendering. */
  function of(locale: Locale): Catalog {
    return loaded.get(locale) ?? {};
  }

  return {
    load,
    of,
    /** The translator for a loader or an action: `const t = await requestTranslator(request)`. */
    async requestTranslator(request: Request): Promise<Translator> {
      const locale = localeFromRequest(request);
      return createTranslator(locale, await load(locale));
    },
    /** The translator for a route's `meta`, read from the root loader's `locale`. */
    metaTranslator(matches: readonly ({ id: string; data?: unknown } | undefined)[]): Translator {
      const root = matches.find((match) => match?.id === "root")?.data as
        | { locale?: Locale }
        | undefined;
      const locale = root?.locale ?? SOURCE_LOCALE;
      return createTranslator(locale, of(locale));
    },
  };
}
