import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BundledModelProvider } from "~/lib/model-provider-catalog";

export type ModelPluginKind = "chat" | "embedding";

export async function bundledModelPlugin(provider: BundledModelProvider, kind: ModelPluginKind) {
  const directory = process.env.BRAINO_PLUGIN_BUNDLE_DIR?.trim() || "/app/plugins";
  const stem = `braino_${provider}_${kind}`;
  const [manifest, component] = await Promise.all([
    readFile(resolve(directory, `${stem}.manifest.json`), "utf8"),
    readFile(resolve(directory, `${stem}.wasm`)),
  ]);
  return { manifest: JSON.parse(manifest) as unknown, component };
}

export async function bundledModelProviderPlugins(provider: BundledModelProvider) {
  const [chat, embedding] = await Promise.all([
    bundledModelPlugin(provider, "chat"),
    bundledModelPlugin(provider, "embedding"),
  ]);
  return { chat, embedding };
}

export async function bundledOllamaModelPlugin(kind: ModelPluginKind) {
  return bundledModelPlugin("ollama", kind);
}
