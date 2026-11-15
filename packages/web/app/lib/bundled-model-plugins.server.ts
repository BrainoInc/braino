import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type ModelPluginEntry,
  includedWithBraino,
  modelPluginEntry,
} from "~/lib/model-plugin-catalog";

const MANIFEST_SUFFIX = ".manifest.json";

function bundleDirectory(): string {
  return process.env.BRAINO_PLUGIN_BUNDLE_DIR?.trim() || "/app/plugins";
}

/** A deployment without a plugin bundle has no bundled plugins; it is not an error. */
async function bundledManifests(): Promise<{ stem: string; manifest: unknown }[]> {
  const directory = bundleDirectory();
  const found = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const files = found.filter((file) => file.endsWith(MANIFEST_SUFFIX)).sort();
  return Promise.all(
    files.map(async (file) => ({
      stem: file.slice(0, -MANIFEST_SUFFIX.length),
      manifest: JSON.parse(await readFile(resolve(directory, file), "utf8")) as unknown,
    })),
  );
}

/** Every model plugin in the bundle, the ones included with Braino first. */
export async function bundledModelPluginCatalog(): Promise<ModelPluginEntry[]> {
  const entries = (await bundledManifests())
    .map((bundled) => modelPluginEntry(bundled.manifest))
    .filter((entry): entry is ModelPluginEntry => entry !== null);
  return entries.sort(
    (a, b) =>
      Number(includedWithBraino(b)) - Number(includedWithBraino(a)) || a.name.localeCompare(b.name),
  );
}

/** One bundled model plugin, ready to install: its catalogue entry, manifest and component. */
export async function bundledModelPlugin(
  pluginId: string,
): Promise<{ entry: ModelPluginEntry; manifest: unknown; component: Uint8Array } | null> {
  for (const bundled of await bundledManifests()) {
    const entry = modelPluginEntry(bundled.manifest);
    if (entry?.id !== pluginId) continue;
    const component = await readFile(resolve(bundleDirectory(), `${bundled.stem}.wasm`));
    return { entry, manifest: bundled.manifest, component };
  }
  return null;
}
