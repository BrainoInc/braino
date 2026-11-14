import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const OLLAMA_CHAT_PLUGIN_ID = "braino.ollama-chat";
export const OLLAMA_EMBEDDING_PLUGIN_ID = "braino.ollama-embedding";

type ModelPluginKind = "chat" | "embedding";

export async function bundledOllamaModelPlugin(kind: ModelPluginKind) {
  const directory = process.env.BRAINO_PLUGIN_BUNDLE_DIR?.trim() || "/app/plugins";
  const stem = `braino_ollama_${kind}`;
  const [manifest, component] = await Promise.all([
    readFile(resolve(directory, `${stem}.manifest.json`), "utf8"),
    readFile(resolve(directory, `${stem}.wasm`)),
  ]);
  return { manifest: JSON.parse(manifest) as unknown, component };
}

export async function bundledOllamaModelPlugins() {
  const [chat, embedding] = await Promise.all([
    bundledOllamaModelPlugin("chat"),
    bundledOllamaModelPlugin("embedding"),
  ]);
  return { chat, embedding };
}
