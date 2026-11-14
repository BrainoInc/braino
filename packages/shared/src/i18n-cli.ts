#!/usr/bin/env node
/**
 * braino-i18n sync  <localesDir> <sourceDir...>   bring every catalog in step with the source
 * braino-i18n check <localesDir> <sourceDir...>   list what is missing or wrong; fails if anything is
 */
import { checkLocales, syncLocales } from "./i18n-catalog.js";

const [command, localesDir, ...sourceDirs] = process.argv.slice(2);
if ((command !== "sync" && command !== "check") || !localesDir || sourceDirs.length === 0) {
  console.error("Usage: braino-i18n <sync|check> <localesDir> <sourceDir...>");
  process.exit(2);
}

if (command === "sync") syncLocales({ sourceDirs, localesDir });
const problems = checkLocales({ sourceDirs, localesDir });
for (const problem of problems) console.error(problem);
if (command === "check" && problems.length) process.exit(1);
