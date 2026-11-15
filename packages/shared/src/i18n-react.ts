/**
 * The translator for React components: `const t = useT()`.
 * `I18nProvider` at the root gives every component the reader's language.
 */
import { Fragment, type ReactNode, createContext, createElement, useContext, useMemo } from "react";
import { type Catalog, type Locale, SOURCE_LOCALE, createTranslator } from "./i18n.js";

type TextValue = string | number;

export interface ReactTranslator {
  (source: string, values?: Readonly<Record<string, TextValue>>): string;
  /** `t.rich("Read the <guide>guide</guide>.", { guide: (children) => <a href="/guide">{children}</a> })` */
  rich(
    source: string,
    values: Readonly<Record<string, TextValue | ((children: ReactNode) => ReactNode)>>,
  ): ReactNode;
  readonly locale: Locale;
}

function reactTranslator(locale: Locale, catalog: Catalog): ReactTranslator {
  const t = createTranslator(locale, catalog);
  return Object.assign(
    (source: string, values?: Readonly<Record<string, TextValue>>) => t(source, values),
    {
      locale,
      rich: (
        source: string,
        values: Readonly<Record<string, TextValue | ((children: ReactNode) => ReactNode)>>,
      ): ReactNode =>
        // A fragment's children given one by one are a sentence's parts, not a list, so
        // React asks no key of them.
        createElement(
          Fragment,
          null,
          ...t.rich<ReactNode>(
            source,
            Object.fromEntries(
              Object.entries(values).map(([name, value]) => [
                name,
                typeof value === "function"
                  ? (children: ReactNode[]) => value(createElement(Fragment, null, ...children))
                  : value,
              ]),
            ),
          ),
        ),
    },
  );
}

const TranslatorContext = createContext<ReactTranslator>(reactTranslator(SOURCE_LOCALE, {}));

export function I18nProvider(props: {
  locale: Locale;
  catalog: Catalog;
  children?: ReactNode;
}): ReactNode {
  const t = useMemo(
    () => reactTranslator(props.locale, props.catalog),
    [props.locale, props.catalog],
  );
  return createElement(TranslatorContext.Provider, { value: t }, props.children);
}

export function useT(): ReactTranslator {
  return useContext(TranslatorContext);
}
