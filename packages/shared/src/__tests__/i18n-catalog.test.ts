import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogProblems,
  checkLocales,
  extractMessages,
  sourceProblems,
  syncLocales,
  untranslatedText,
} from "../i18n-catalog.js";
import { LOCALES } from "../i18n.js";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "braino-i18n-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("extractMessages", () => {
  it("finds every sentence passed to t, t.rich and msg", () => {
    const uses = extractMessages(
      "page.tsx",
      `
      const title = msg("Workspace");
      export function Page() {
        const t = useT();
        return (
          <p title={t("Sign in")}>
            {t("{count, plural, one {# record} other {# records}}", { count })}
            {t.rich(\`Read the <guide>guide</guide>.\`, { guide })}
            {t(error)}
          </p>
        );
      }`,
    );
    expect(uses.map((use) => [use.call, use.text, use.hasValues])).toEqual([
      ["msg", "Workspace", false],
      ["t", "Sign in", false],
      ["t", "{count, plural, one {# record} other {# records}}", true],
      ["rich", "Read the <guide>guide</guide>.", true],
    ]);
    expect(uses[1]).toMatchObject({ file: "page.tsx", line: 6 });
  });
});

describe("sourceProblems", () => {
  it("accepts well-formed sentences", () => {
    expect(
      sourceProblems(
        extractMessages(
          "a.ts",
          `t("Sign in"); t("Signed in as {name}", { name }); msg("{count} left"); t.rich("<b>Go</b>", { b });`,
        ),
      ),
    ).toEqual([]);
  });

  it("names a malformed sentence, one shown without its values, and a marked part shown as text", () => {
    const problems = sourceProblems(
      extractMessages(
        "a.ts",
        `t("Signed in as {name"); t("Signed in as {name}"); t("<b>Go</b>", {});`,
      ),
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/a\.ts:1 Expected \} or ,/);
    expect(problems[1]).toMatch(/a\.ts:1.*values/);
    expect(problems[2]).toMatch(/a\.ts:1.*t\.rich/);
  });
});

describe("untranslatedText", () => {
  it("names words written straight into a component", () => {
    expect(
      untranslatedText(
        "page.tsx",
        `export const Page = () => (
          <Card title="Workspace settings" className="p-4">
            <input placeholder="Search workspace" aria-label="Search" name="q" type="search" />
            Sign in
          </Card>
        );`,
      ),
    ).toEqual([
      'page.tsx:2 shows "Workspace settings" untranslated',
      'page.tsx:3 shows "Search workspace" untranslated',
      'page.tsx:3 shows "Search" untranslated',
      'page.tsx:4 shows "Sign in" untranslated',
    ]);
  });

  it("accepts translated text, symbols, and text marked as the same in every language", () => {
    expect(
      untranslatedText(
        "page.tsx",
        `export const Page = () => (
          <Card title={t("Workspace settings")} confirmLabel={label}>
            {t("Sign in")} · › {count} <code>{"pnpm verify"}</code> {"Braino"}
            <Link to="/admin" title={"MCP"}>{t("Admin")}</Link>
          </Card>
        );`,
      ),
    ).toEqual([]);
  });
});

describe("catalogProblems", () => {
  const plural = "{count, plural, one {# record} other {# records}}";

  it("accepts a complete catalog", () => {
    expect(
      catalogProblems("es", ["Sign in", plural], {
        "Sign in": "Iniciar sesión",
        [plural]: "{count, plural, one {# registro} other {# registros}}",
      }),
    ).toEqual([]);
  });

  it("names a missing, an empty and a stale sentence", () => {
    const problems = catalogProblems("es", ["Sign in", "Sign out"], {
      "Sign out": "",
      Gone: "Ido",
    });
    expect(problems).toEqual([
      'es has no translation of "Sign in"',
      'es has no translation of "Sign out"',
      'es translates "Gone", which the source no longer says',
    ]);
  });

  it("names a translation that drops a value or a marked part", () => {
    expect(
      catalogProblems("es", ["Signed in as {name}", "<b>Go</b> now"], {
        "Signed in as {name}": "Sesión iniciada",
        "<b>Go</b> now": "Ir ahora",
      }),
    ).toEqual([
      'es translation of "Signed in as {name}" must use exactly: {name}',
      'es translation of "<b>Go</b> now" must use exactly: <b>',
    ]);
  });

  it("names a plural that lacks a form the language needs", () => {
    expect(
      catalogProblems("ru", [plural], {
        [plural]: "{count, plural, one {# запись} other {# записи}}",
      }),
    ).toEqual([`ru translation of "${plural}" lacks the plural forms: many, few`]);
    expect(catalogProblems("ja", [plural], { [plural]: "{count, plural, other {#件}}" })).toEqual(
      [],
    );
  });

  it("names an ordinal that lacks a form the language needs", () => {
    const ordinal = "{rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect(
      catalogProblems("en", [ordinal], { [ordinal]: "{rank, selectordinal, other {#th}}" }),
    ).toEqual([`en translation of "${ordinal}" lacks the plural forms: one, two, few`]);
    expect(
      catalogProblems("ja", [ordinal], { [ordinal]: "{rank, selectordinal, other {#位}}" }),
    ).toEqual([]);
  });

  it("names a malformed translation", () => {
    expect(catalogProblems("es", ["Hi {name}"], { "Hi {name}": "Hola {name" })[0]).toMatch(
      /^es translation of "Hi \{name\}" is malformed: Expected \} or ,/,
    );
  });
});

describe("the catalogs on disk", () => {
  const source = `export const a = t("Sign in"); export const b = msg("Sign out");`;

  it("sync adds what the source says, drops what it stopped saying, and keeps translations", () => {
    const root = project({
      "app/page.tsx": source,
      "app/page.test.tsx": `t("Only a test says this")`,
      "app/locales/es.json": JSON.stringify({ "Sign in": "Iniciar sesión", Gone: "Ido" }),
    });
    syncLocales({ sourceDirs: [join(root, "app")], localesDir: join(root, "app/locales") });
    expect(readFileSync(join(root, "app/locales/es.json"), "utf8")).toBe(
      '{\n  "Sign in": "Iniciar sesión",\n  "Sign out": ""\n}\n',
    );
    expect(JSON.parse(readFileSync(join(root, "app/locales/ar.json"), "utf8"))).toEqual({
      "Sign in": "",
      "Sign out": "",
    });
  });

  it("check reports every language that is behind the source", () => {
    const root = project({ "app/page.tsx": source });
    const options = { sourceDirs: [join(root, "app")], localesDir: join(root, "app/locales") };
    syncLocales(options);
    const problems = checkLocales(options);
    expect(problems).toHaveLength((LOCALES.length - 1) * 2);
    expect(problems[0]).toBe('es has no translation of "Sign in"');

    for (const { code } of LOCALES.slice(1)) {
      writeFileSync(
        join(root, `app/locales/${code}.json`),
        JSON.stringify({ "Sign in": "x", "Sign out": "y" }),
      );
    }
    expect(checkLocales(options)).toEqual([]);
  });

  it("check reports untranslated components, except those still waiting their turn", () => {
    const root = project({
      "app/routes/new.tsx": "export const New = () => <p>Sign in</p>;",
      "app/routes/old.tsx": "export const Old = () => <p>Sign out</p>;",
    });
    const options = { sourceDirs: [join(root, "app")], localesDir: join(root, "app/locales") };
    expect(checkLocales({ ...options, notYetTranslated: ["app/routes/old.tsx"] })).toEqual([
      `${join(root, "app/routes/new.tsx")}:1 shows "Sign in" untranslated`,
    ]);
  });
});
