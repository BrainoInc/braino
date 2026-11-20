import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

const rootDir = resolve(import.meta.dirname, "../..");
const rootPackage = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8")) as {
  version: string;
};

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function git(command: string): string | null {
  try {
    return clean(execSync(command, { cwd: rootDir }).toString());
  } catch {
    return null;
  }
}

const version =
  clean(process.env.DOCO_VERSION) ?? git("git rev-parse --short=7 HEAD") ?? rootPackage.version;
const releaseAt = git("git log -1 --format=%cI") ?? new Date().toISOString();

export default defineConfig({
  define: {
    __DOCO_VERSION__: JSON.stringify(version),
    __DOCO_RELEASE_AT__: JSON.stringify(releaseAt),
  },
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths()],
  server: { host: "127.0.0.1", port: 5173 },
  resolve: { dedupe: ["react", "react-dom"] },
  ssr: {
    external: ["pg"],
    noExternal: ["@react-router/node", "@doco/db", "@doco/host", "@doco/shared", "react-router"],
  },
});
