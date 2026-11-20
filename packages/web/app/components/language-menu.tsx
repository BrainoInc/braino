import { LOCALES, LOCALE_PARAM, type Locale } from "@doco/shared/i18n";
import { useT } from "@doco/shared/i18n/react";
import { BR, CN, DE, ES, FR, GB, IN, JP, KR, RU } from "country-flag-icons/react/3x2";
import { useLocation } from "react-router";

type FlagProps = { className: string; "aria-hidden": true };

/** The Arab League's flag, which stands for Arabic as no one country's flag can. */
function ArabLeague({ className }: FlagProps) {
  return <img src="/flags/arab-league.svg" alt="" aria-hidden className={className} />;
}

/** The flag websites fly for each language, rather than for a country choice. */
const FLAGS: Record<Locale, (props: FlagProps) => React.JSX.Element> = {
  en: GB,
  es: ES,
  "zh-CN": CN,
  ja: JP,
  de: DE,
  fr: FR,
  "pt-BR": BR,
  ko: KR,
  ru: RU,
  hi: IN,
  ar: ArabLeague,
};

function Flag({ locale }: { locale: Locale }) {
  const Image = FLAGS[locale];
  return (
    <Image aria-hidden className="h-4 w-6 shrink-0 rounded-[2px] object-cover ring-1 ring-border" />
  );
}

/** The reader's language as a flag, and a flag for each language to switch to. */
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
        className="neu-button flex cursor-pointer list-none items-center rounded-md px-2.5 py-1.5"
        aria-label={t("Language")}
        title={t("Language")}
      >
        <Flag locale={t.locale} />
      </summary>
      <ul className="neu-surface absolute end-0 z-10 mt-2 grid w-max grid-cols-4 gap-1 rounded-md bg-card p-1">
        {LOCALES.map((locale) => (
          <li key={locale.code}>
            <a
              href={hrefFor(locale.code)}
              lang={locale.code}
              hrefLang={locale.code}
              aria-label={locale.name}
              title={locale.name}
              aria-current={locale.code === t.locale ? "true" : undefined}
              className="block rounded p-2 hover:bg-muted aria-[current]:shadow-(--neu-pressed)"
            >
              <Flag locale={locale.code} />
            </a>
          </li>
        ))}
      </ul>
    </details>
  );
}
