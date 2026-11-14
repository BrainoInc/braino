import { catalogStore } from "@doco/shared/i18n";

// One catalog per language beside this file, each fetched only when a reader asks for it.
export const catalogs = catalogStore(import.meta.glob("./*.json", { import: "default" }));
export const { requestTranslator, metaTranslator } = catalogs;
