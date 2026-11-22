export const APP_IDS = ["ollama", "openai", "slack", "resend"] as const;

export type AppId = (typeof APP_IDS)[number];

export function appId(value: string | undefined): AppId | null {
  return APP_IDS.find((candidate) => candidate === value) ?? null;
}

export const APP_PLUGIN_IDS = {
  ollama: ["braino.ollama-chat", "braino.ollama-embedding"],
  openai: ["braino.openai-chat", "braino.openai-embedding"],
  slack: ["braino.slack"],
  resend: ["braino.resend"],
} as const satisfies Record<AppId, readonly string[]>;

export const AI_APP_IDS = ["ollama", "openai"] as const satisfies readonly AppId[];

export type AiAppId = (typeof AI_APP_IDS)[number];

export function isAiApp(id: AppId): id is AiAppId {
  return (AI_APP_IDS as readonly AppId[]).includes(id);
}

export function modelPluginId(app: AiAppId, kind: "chat" | "embedding"): string {
  return `braino.${app}-${kind}`;
}
