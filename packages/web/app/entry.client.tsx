import { LOCALE_PARAM, type Locale, localeCookie } from "@braino/shared/i18n";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { catalogs } from "~/locales/catalog";

const locale = document.documentElement.lang as Locale;
// A language picked with ?lang= stays picked on the pages that follow.
if (new URLSearchParams(location.search).has(LOCALE_PARAM)) document.cookie = localeCookie(locale);

// The page arrives already translated; hydrate it with the same language.
catalogs.load(locale).then(() => {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <HydratedRouter />
      </StrictMode>,
    );
  });
});
