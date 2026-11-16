import type { ModelCapability, ModelPluginStatus } from "@doco/host";
import {
  parsePluginManifest,
  pluginConfigurationChoices,
  pluginProvidesCapability,
} from "@doco/plugin-runtime";

/** The two models Braino needs, as they appear in setup URLs. */
export const MODEL_KINDS = ["chat", "embedding"] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

export const MODEL_CAPABILITY = {
  chat: "chat.complete",
  embedding: "embedding.embed",
} as const satisfies Record<ModelKind, ModelCapability>;

export function modelKind(value: string | undefined): ModelKind | null {
  return MODEL_KINDS.find((kind) => kind === value) ?? null;
}

/** One model plugin, described only by what its manifest declares. */
export interface ModelPluginEntry {
  id: string;
  name: string;
  kind: ModelKind;
  networkHosts: string[];
  /** Every host the plugin may reach is on this server or its private network. */
  local: boolean;
  /** The secrets the plugin cannot run without; each plugin holds its own. */
  requiredSecrets: string[];
  defaultModel: string;
  suggestedModels: string[];
  /** Embedding plugins only. */
  defaultDimensions: string | null;
}

function localHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "");
  return name === "localhost" || name === "127.0.0.1" || !name.includes(".");
}

/**
 * Describes a manifest as a model plugin, or returns null when it is not one:
 * it must provide exactly one of the two models and declare a default model.
 */
export function modelPluginEntry(value: unknown): ModelPluginEntry | null {
  const manifest = parsePluginManifest(value);
  const kinds = MODEL_KINDS.filter((kind) =>
    pluginProvidesCapability(manifest, MODEL_CAPABILITY[kind]),
  );
  const kind = kinds[0];
  const model = pluginConfigurationChoices(manifest, "model");
  if (kinds.length !== 1 || !kind || !model.default) return null;
  const required = manifest.secretSchema?.required;
  return {
    id: manifest.id,
    name: manifest.name,
    kind,
    networkHosts: [...manifest.permissions.network],
    local: manifest.permissions.network.every(localHost),
    requiredSecrets: Array.isArray(required)
      ? required.filter((name): name is string => typeof name === "string")
      : [],
    defaultModel: model.default,
    suggestedModels: [...model.suggested],
    defaultDimensions:
      kind === "embedding" ? pluginConfigurationChoices(manifest, "dimensions").default : null,
  };
}

/** Plugins that stay on this server come with Braino; the rest are listed as marketplace plugins. */
export function includedWithBraino(entry: ModelPluginEntry): boolean {
  return entry.local;
}

/** The plugin Braino pre-selects for a model nobody has configured yet. */
export function preselectedPlugin(
  catalog: readonly ModelPluginEntry[],
  kind: ModelKind,
): ModelPluginEntry | null {
  return catalog.find((entry) => entry.kind === kind && includedWithBraino(entry)) ?? null;
}

/** A plugin installed in the workspace, as the setup screens need to see it. */
export interface InstalledModelPlugin {
  pluginId: string;
  name: string;
  kind: ModelKind;
  enabled: boolean;
  configuration: Readonly<Record<string, string>>;
  secretNames: readonly string[];
}

export interface ModelStep {
  kind: ModelKind;
  /** `preselected`: nothing is assigned yet and Braino offers its default. */
  status: ModelPluginStatus | "preselected";
  pluginId: string | null;
  pluginName: string | null;
  model: string | null;
  usesDefault: boolean;
  usesOwnKey: boolean;
}

/** What the setup screen shows for each model: the assigned plugin, or the one pre-selected. */
export function modelSteps(
  readiness: Readonly<Record<ModelKind, ModelPluginStatus>>,
  catalog: readonly ModelPluginEntry[],
  installed: readonly InstalledModelPlugin[],
): ModelStep[] {
  return MODEL_KINDS.map((kind) => {
    const status = readiness[kind];
    const assigned = installed.filter((plugin) => plugin.kind === kind && plugin.enabled);
    const plugin = assigned.length === 1 ? assigned[0] : undefined;
    if (plugin) {
      const entry = catalog.find((candidate) => candidate.id === plugin.pluginId);
      const model = plugin.configuration.model?.trim() || null;
      return {
        kind,
        status,
        pluginId: plugin.pluginId,
        pluginName: plugin.name,
        model,
        usesDefault:
          preselectedPlugin(catalog, kind)?.id === plugin.pluginId && entry?.defaultModel === model,
        usesOwnKey: plugin.secretNames.length > 0,
      };
    }
    const offered = status === "missing" ? preselectedPlugin(catalog, kind) : null;
    return {
      kind,
      status: offered ? "preselected" : status,
      pluginId: offered?.id ?? null,
      pluginName: offered?.name ?? null,
      model: offered?.defaultModel ?? null,
      usesDefault: Boolean(offered),
      usesOwnKey: false,
    };
  });
}
