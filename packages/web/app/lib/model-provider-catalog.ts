export type BundledModelProvider = "ollama" | "openai";

export const OLLAMA_CHAT_PLUGIN_ID = "braino.ollama-chat";
export const OLLAMA_EMBEDDING_PLUGIN_ID = "braino.ollama-embedding";
export const OPENAI_CHAT_PLUGIN_ID = "braino.openai-chat";
export const OPENAI_EMBEDDING_PLUGIN_ID = "braino.openai-embedding";

export const MODEL_PROVIDER_DEFAULTS = {
  ollama: {
    chatModel: "qwen3.5:2b",
    embeddingModel: "embeddinggemma-2:270m",
    embeddingDimensions: "768",
  },
  openai: {
    chatModel: "gpt-4.1-mini",
    embeddingModel: "text-embedding-3-small",
    embeddingDimensions: "1536",
  },
} as const satisfies Record<
  BundledModelProvider,
  { chatModel: string; embeddingModel: string; embeddingDimensions: string }
>;

export function modelProvider(value: string): BundledModelProvider | null {
  return value === "ollama" || value === "openai" ? value : null;
}
