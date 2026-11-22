import type { ModelKind } from "~/lib/model-plugin-catalog";

export const PLUGIN_PAGE_IDS = [
  "ollama-chat",
  "ollama-embedding",
  "openai-chat",
  "openai-embedding",
  "slack",
  "resend",
] as const;

export type PluginPageId = (typeof PLUGIN_PAGE_IDS)[number];

export function pluginPageId(value: string | undefined): PluginPageId | null {
  return PLUGIN_PAGE_IDS.find((candidate) => candidate === value) ?? null;
}

export const PLUGIN_MANIFEST_IDS = {
  "ollama-chat": "braino.ollama-chat",
  "ollama-embedding": "braino.ollama-embedding",
  "openai-chat": "braino.openai-chat",
  "openai-embedding": "braino.openai-embedding",
  slack: "braino.slack",
  resend: "braino.resend",
} as const satisfies Record<PluginPageId, string>;

export const MODEL_PLUGIN_PAGE_IDS = [
  "ollama-chat",
  "ollama-embedding",
  "openai-chat",
  "openai-embedding",
] as const satisfies readonly PluginPageId[];

export type ModelPluginPageId = (typeof MODEL_PLUGIN_PAGE_IDS)[number];

export function isModelPluginPage(id: PluginPageId): id is ModelPluginPageId {
  return (MODEL_PLUGIN_PAGE_IDS as readonly PluginPageId[]).includes(id);
}

export function modelKindForPlugin(id: ModelPluginPageId): ModelKind {
  return id.endsWith("-chat") ? "chat" : "embedding";
}
