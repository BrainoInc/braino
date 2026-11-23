import { LOGOS, type LogoId } from "~/lib/logos";
import type { PluginPageId } from "~/lib/plugin-catalog";

const PLUGIN_LOGOS = {
  "ollama-chat": "ollama",
  "ollama-embedding": "ollama",
  "openai-chat": "openai",
  "openai-embedding": "openai",
  slack: "slack",
  resend: "resend",
} as const satisfies Record<PluginPageId, LogoId>;

export function PluginLogo({ pluginId }: { pluginId: PluginPageId }) {
  const logo = LOGOS[PLUGIN_LOGOS[pluginId]];
  return (
    <span
      aria-hidden="true"
      className="flex size-10 shrink-0 items-center justify-center rounded-xl shadow-sm"
      style={{ backgroundColor: logo.color }}
    >
      <svg viewBox="0 0 24 24" className="size-6 fill-white">
        <title>{logo.name}</title>
        <path d={logo.path} />
      </svg>
    </span>
  );
}
