import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../../");
const LEGACY_NAME = String.fromCharCode(100, 111, 99, 111);
const DEPLOYMENT_ENV_SUFFIXES = [
  "DATABASE_CA",
  "DATABASE_CERT",
  "DATABASE_KEY",
  "DATABASE_POOL_MAX",
  "DATABASE_URL",
  "EMBEDDING_PROVIDER",
  "ENCRYPTION_KEY",
  "VOYAGE_EMBEDDING_MODEL",
] as const;
const DEPLOYMENT_ENVIRONMENT_VARIABLE = new RegExp(
  `\\b${LEGACY_NAME.toUpperCase()}_(?:${DEPLOYMENT_ENV_SUFFIXES.join("|")})\\b`,
  "g",
);
const IMMUTABLE_MIGRATIONS = new Set([
  "packages/db/migrations/002_braino_product_identity.sql",
  "packages/db/migrations/026_activity_writes.sql",
]);

function trackedTextFiles(): Array<{ path: string; text: string }> {
  const paths = execFileSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

  return paths.flatMap((path) => {
    if (IMMUTABLE_MIGRATIONS.has(path)) return [];
    const contents = readFileSync(resolve(REPOSITORY_ROOT, path));
    if (contents.includes(0)) return [];
    return [{ path, text: contents.toString("utf8") }];
  });
}

describe("product branding", () => {
  it("contains no legacy product name in tracked paths or text", () => {
    const pattern = new RegExp(LEGACY_NAME, "i");
    const failures = trackedTextFiles().flatMap(({ path, text }) => {
      const matches = [];
      if (pattern.test(path)) matches.push(`${path}: path`);
      if (pattern.test(text.replace(DEPLOYMENT_ENVIRONMENT_VARIABLE, ""))) {
        matches.push(`${path}: contents`);
      }
      return matches;
    });

    expect(failures).toEqual([]);
  });
});
