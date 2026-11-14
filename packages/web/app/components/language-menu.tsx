import { LOCALES, LOCALE_PARAM } from "@doco/shared/i18n";
import { useT } from "@doco/shared/i18n/react";
import { Languages } from "lucide-react";
import { useLocation } from "react-router";

/** The reader's language, and the others to switch to. Each link reloads the page in its language. */
export function LanguageMenu() {
  const t = useT();
  const location = useLocation();
  const hrefFor = (code: string) => {
    const search = new URLSearchParams(location.search);
    search.set(LOCALE_PARAM, code);
    return `${location.pathname}?${search}`;
  };
  return (
    <details className="relative">
      <summary
        className="neu-button flex cursor-pointer list-none items-center gap-1.5 rounded-md px-2.5 py-1.5 font-semibold"
        aria-label={t("Language")}
        title={t("Language")}
      >
        <Languages size={14} aria-hidden />
        {LOCALES.find((locale) => locale.code === t.locale)?.name}
      </summary>
      <ul className="neu-surface absolute end-0 z-10 mt-2 min-w-40 rounded-md bg-card p-1">
        {LOCALES.map((locale) => (
          <li key={locale.code}>
            <a
              href={hrefFor(locale.code)}
              lang={locale.code}
              hrefLang={locale.code}
              aria-current={locale.code === t.locale ? "true" : undefined}
              className="block rounded px-2.5 py-1.5 hover:bg-muted aria-[current]:font-semibold"
            >
              {locale.name}
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
