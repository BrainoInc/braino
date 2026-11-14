import { resolve } from "node:path";
import { checkLocales } from "@doco/shared/i18n/catalog";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname, "..");

describe("Braino's translations", () => {
  it("translates every sentence the interface shows into every language", () => {
    // Out of step? `pnpm --filter @doco/web i18n:sync` rewrites the catalogs
    // beside this file; fill in what it leaves empty.
    expect(checkLocales({ sourceDirs: [app], localesDir: import.meta.dirname })).toEqual([]);
  });
});
