import { LOGOS, type LogoId } from "./logos.js";

export type { LogoId } from "./logos.js";

export const BUILT_IN_PLUGIN_BRANDS = {
  "ollama-chat": "ollama",
  "ollama-embedding": "ollama",
  "openai-chat": "openai",
  "openai-embedding": "openai",
  slack: "slack",
  resend: "resend",
} as const satisfies Record<string, LogoId>;

export type BuiltInPluginId = keyof typeof BUILT_IN_PLUGIN_BRANDS;

export function PluginLogo(
  props: { brand: LogoId; pluginId?: never } | { pluginId: BuiltInPluginId; brand?: never },
) {
  const brand = props.brand ?? BUILT_IN_PLUGIN_BRANDS[props.pluginId];
  const logo = LOGOS[brand];
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
