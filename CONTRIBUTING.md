# Contributing

Work from a short-lived branch and open a pull request against `main`. Keep each
change small enough to review and integrate quickly; squash-merge after the
required checks pass. Long-lived release or integration branches are not used.

To release, bump the version in the root `package.json` and every
`packages/*/package.json` to the same new number in a pull request. Merging it
to `main` publishes `v<version>`: the release workflow verifies that commit,
publishes its packages and signed images, and creates the tag. Don't push tags
by hand.

Run the focused tests for the code you change during development. The canonical
repository gate is:

```sh
pnpm verify
```

Behavior changes should begin with a failing test that captures the intended
result, then make that test pass and refactor while it remains green.

## Translations

Braino's interface is written in English and translated into ten languages:
Spanish, Simplified Chinese, Japanese, German, French, Brazilian Portuguese,
Korean, Russian, Hindi and Arabic (`LOCALES` in `packages/shared/src/i18n.ts`).
The English sentence in the source is the key. English needs no catalog, and
each other language has one file, `packages/web/app/locales/<code>.json`, that
maps every English sentence to its translation.

Every word a person reads goes through the translator:

```tsx
import { useT } from "@braino/shared/i18n/react";

function Results({ count, query }: { count: number; query: string }) {
  const t = useT();
  return (
    <section>
      <h2>{t("Search")}</h2>
      <input placeholder={t("Record text, title, locator, or ID")} />
      <p>{t("{count, plural, one {# result} other {# results}} for “{query}”", { count, query })}</p>
      <p>
        {t.rich("Read the <guide>operations guide</guide> first.", {
          guide: (children) => <Link to="/guide">{children}</Link>,
        })}
      </p>
    </section>
  );
}
```

- **One sentence, one `t`.** Never join translated pieces or append an "s":
  word order and plurals differ by language. Put values in `{name}`, counts in
  `{count, plural, one {…} other {…}}`, places in
  `{rank, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}`, choices in
  `{kind, select, a {…} other {…}}`, and wrap a link or emphasis inside a
  sentence with `t.rich` and `<name>…</name>`.
- **On the server**, a loader or action gets its translator from the request
  (`const t = await requestTranslator(request)`, from `~/locales/catalog`) and
  a route's `meta` from its matches (`const t = metaTranslator(matches)`).
- **Text made where no translator is at hand** (a constant table, an error a
  helper returns) is marked with `msg("…")` from `@braino/shared/i18n` and shown
  with `t(text)`.
- **Text that reads the same in every language** (Braino, a command, a
  handle) is written in braces, `{"Braino"}`, to say so on purpose.
- **Numbers and dates** follow the reader's language: pass a number as a
  number, and format a date with `toLocaleString(t.locale)`.
- **Layout follows the reading direction.** Arabic reads right to left, so use
  Tailwind's logical utilities (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`,
  `text-start`, `text-end`, `rounded-s-`, `rounded-e-`, `border-s`,
  `border-e`) instead of the left/right ones.
- **What stays English:** the HTTP API, MCP tools and OAuth errors, logs, and
  what people wrote themselves (records, handles, names).

After adding or changing a sentence, run `pnpm --filter @braino/web i18n:sync`.
It adds the new sentence to every catalog with an empty translation and drops
sentences the source no longer says; fill in each empty translation, keeping
the same `{values}` and `<parts>` and giving each plural the forms its language
needs. `app/locales/catalog.test.ts` fails while any language lacks a sentence
or a component shows words without translating them, so `pnpm verify` keeps
all ten languages complete.
