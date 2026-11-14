import { LOCALE_PARAM, type Locale, localeCookie } from "@doco/shared/i18n";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { HydratedRouter } from "react-router/dom";
import { loadCatalog } from "~/locales/catalog";

// The page arrives already translated; hydrate it with the same language.
const locale = document.documentElement.lang as Locale;
await loadCatalog(locale);
// A language picked with ?lang= stays picked on the pages that follow.
if (new URLSearchParams(location.search).has(LOCALE_PARAM)) document.cookie = localeCookie(locale);

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <HydratedRouter />
    </StrictMode>,
  );
});
