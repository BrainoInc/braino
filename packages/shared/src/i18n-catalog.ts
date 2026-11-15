/**
 * Keeps each language's catalog in step with the English in the source.
 * Node only: it reads the source with the TypeScript compiler.
 *
 * `syncLocales` rewrites `<localesDir>/<code>.json` to hold exactly the
 * sentences the source passes to `t`, `t.rich` and `msg` (new ones empty);
 * `checkLocales` lists everything still missing or wrong. A test that expects
 * `checkLocales(...)` to be empty is what keeps every language complete.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  type Catalog,
  LOCALES,
  type Locale,
  type MessageNode,
  SOURCE_LOCALE,
  parseMessage,
} from "./i18n.js";

export interface MessageUse {
  text: string;
  call: "t" | "rich" | "msg";
  hasValues: boolean;
  file: string;
  line: number;
}

/** Every literal sentence a file passes to `t(…)`, `t.rich(…)` or `msg(…)`. */
export function extractMessages(file: string, code: string): MessageUse[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const uses: MessageUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const call =
        ts.isIdentifier(callee) && (callee.text === "t" || callee.text === "msg")
          ? callee.text
          : ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.expression) &&
              callee.expression.text === "t" &&
              callee.name.text === "rich"
            ? "rich"
            : null;
      const first = node.arguments[0];
      if (
        call &&
        first &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        uses.push({
          text: first.text,
          call,
          hasValues: node.arguments.length > 1,
          file,
          line: source.getLineAndCharacterOfPosition(first.getStart(source)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

const HAS_WORDS = /\p{L}{2}/u;
const TEXT_ATTRIBUTE =
  /^(aria-(label|description|placeholder|valuetext)|alt|placeholder|title|label|.*(Label|Title|Text|Message|Placeholder|Description|Heading))$/;

/**
 * Words a component shows without translating them: text written straight into
 * JSX, or given as a plain string to an attribute people read. Text that reads
 * the same in every language (a brand, a code sample) goes in braces instead,
 * `{"Braino"}`, which says so on purpose.
 */
export function untranslatedText(file: string, code: string): string[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const report = (node: ts.Node, text: string) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    problems.push(`${file}:${line} shows "${text.trim().replace(/\s+/g, " ")}" untranslated`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && HAS_WORDS.test(node.text)) report(node, node.text);
    if (
      ts.isJsxAttribute(node) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer) &&
      TEXT_ATTRIBUTE.test(node.name.getText(source)) &&
      HAS_WORDS.test(node.initializer.text)
    ) {
      report(node.initializer, node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

/** What a sentence expects to be given: `{name}` values and `<name>` parts. */
function signature(nodes: MessageNode[], found = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (typeof node === "string" || node.kind === "number") continue;
    if (node.kind === "tag") {
      found.add(`<${node.name}>`);
      signature(node.children, found);
    } else {
      found.add(`{${node.name}}`);
      if (node.kind !== "value")
        for (const option of node.options.values()) signature(option, found);
    }
  }
  return found;
}

function plurals(
  nodes: MessageNode[],
  found: { ordinal: boolean; options: Map<string, MessageNode[]> }[] = [],
) {
  for (const node of nodes) {
    if (typeof node === "string" || node.kind === "number" || node.kind === "value") continue;
    if (node.kind === "tag") plurals(node.children, found);
    else {
      if (node.kind !== "select") {
        found.push({ ordinal: node.kind === "selectordinal", options: node.options });
      }
      for (const option of node.options.values()) plurals(option, found);
    }
  }
  return found;
}

/** Sentences in the source that can't be shown as written. */
export function sourceProblems(uses: MessageUse[]): string[] {
  const problems: string[] = [];
  for (const use of uses) {
    const where = `${use.file}:${use.line}`;
    let expects: Set<string>;
    try {
      expects = signature(parseMessage(use.text));
    } catch (error) {
      problems.push(`${where} ${(error as Error).message}`);
      continue;
    }
    const marksPart = [...expects].some((name) => name.startsWith("<"));
    if (use.call === "t" && marksPart) {
      problems.push(`${where} "${use.text}" marks a part; show it with t.rich`);
    } else if (use.call !== "msg" && expects.size > 0 && !use.hasValues) {
      problems.push(`${where} "${use.text}" is shown without its values`);
    }
  }
  return problems;
}

/**
 * The plural (or, for an ordinal, place) forms a language uses for the counts an
 * interface shows. Spanish, French and Portuguese keep a form for exact millions
 * that reads the same as "other", so a translation need not spell it out.
 */
function everydayPluralForms(locale: Locale, ordinal: boolean): string[] {
  const rules = new Intl.PluralRules(locale, { type: ordinal ? "ordinal" : "cardinal" });
  return [...new Set(Array.from({ length: 201 }, (_, count) => rules.select(count)))];
}

/** Where a language's catalog differs from what the source says. */
export function catalogProblems(locale: Locale, sources: string[], catalog: Catalog): string[] {
  const problems: string[] = [];
  const forms = {
    cardinal: everydayPluralForms(locale, false),
    ordinal: everydayPluralForms(locale, true),
  };
  for (const source of sources) {
    const translation = catalog[source];
    if (!translation) {
      problems.push(`${locale} has no translation of "${source}"`);
      continue;
    }
    let nodes: MessageNode[];
    let expects: string[];
    try {
      expects = [...signature(parseMessage(source))].sort();
      nodes = parseMessage(translation);
    } catch (error) {
      problems.push(
        `${locale} translation of "${source}" is malformed: ${(error as Error).message}`,
      );
      continue;
    }
    if ([...signature(nodes)].sort().join() !== expects.join()) {
      problems.push(`${locale} translation of "${source}" must use exactly: ${expects.join(", ")}`);
      continue;
    }
    const lacking = [
      ...new Set(
        plurals(nodes).flatMap(({ ordinal, options }) =>
          (ordinal ? forms.ordinal : forms.cardinal).filter((form) => !options.has(form)),
        ),
      ),
    ];
    if (lacking.length) {
      problems.push(
        `${locale} translation of "${source}" lacks the plural forms: ${lacking.join(", ")}`,
      );
    }
  }
  const known = new Set(sources);
  for (const key of Object.keys(catalog)) {
    if (!known.has(key)) {
      problems.push(`${locale} translates "${key}", which the source no longer says`);
    }
  }
  return problems;
}

const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "build", "__tests__", "locales"]);

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        return SKIPPED_FOLDERS.has(entry.name) || entry.name.startsWith(".")
          ? []
          : sourceFiles(path);
      }
      return /\.(ts|tsx|mts|mjs)$/.test(entry.name) && !/\.(test|d)\.[a-z]+$/.test(entry.name)
        ? [path]
        : [];
    });
}

export interface LocaleFolders {
  /** Folders whose source is read for sentences; tests are skipped. */
  sourceDirs: string[];
  /** Folder holding one `<code>.json` catalog per language. */
  localesDir: string;
  /**
   * Components still waiting to be translated, as path endings. Only a codebase
   * part-way through its first translation lists any; the list only shrinks.
   */
  notYetTranslated?: string[];
}

function readUses(sourceDirs: string[]): MessageUse[] {
  return sourceDirs
    .flatMap(sourceFiles)
    .flatMap((file) => extractMessages(file, readFileSync(file, "utf8")));
}

function readUntranslated(sourceDirs: string[], notYetTranslated: string[]): string[] {
  return sourceDirs
    .flatMap(sourceFiles)
    .filter((file) => file.endsWith(".tsx") && !notYetTranslated.some((end) => file.endsWith(end)))
    .flatMap((file) => untranslatedText(file, readFileSync(file, "utf8")));
}

function catalogPath(localesDir: string, locale: Locale): string {
  return join(localesDir, `${locale}.json`);
}

function readCatalog(localesDir: string, locale: Locale): Catalog {
  const path = catalogPath(localesDir, locale);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Catalog) : {};
}

const TRANSLATED = LOCALES.map((locale) => locale.code).filter((code) => code !== SOURCE_LOCALE);

export function checkLocales({
  sourceDirs,
  localesDir,
  notYetTranslated = [],
}: LocaleFolders): string[] {
  const uses = readUses(sourceDirs);
  const sources = [...new Set(uses.map((use) => use.text))];
  return [
    ...readUntranslated(sourceDirs, notYetTranslated),
    ...sourceProblems(uses),
    ...TRANSLATED.flatMap((locale) =>
      catalogProblems(locale, sources, readCatalog(localesDir, locale)),
    ),
  ];
}

export function syncLocales({ sourceDirs, localesDir }: LocaleFolders): void {
  const sources = [...new Set(readUses(sourceDirs).map((use) => use.text))].sort();
  mkdirSync(localesDir, { recursive: true });
  for (const locale of TRANSLATED) {
    const current = readCatalog(localesDir, locale);
    const next = Object.fromEntries(sources.map((source) => [source, current[source] ?? ""]));
    writeFileSync(catalogPath(localesDir, locale), `${JSON.stringify(next, null, 2)}\n`);
  }
}
