/** The contract version Braino implements for every public plugin capability. */
export const PLUGIN_CAPABILITY_CONTRACT_VERSIONS = {
  "source.pull": 1,
  "event.receive": 1,
  "email.send": 1,
  "team_chat.send": 1,
  "embedding.embed": 1,
  "chat.complete": 1,
} as const;

export const PLUGIN_CAPABILITIES = Object.freeze(
  Object.keys(PLUGIN_CAPABILITY_CONTRACT_VERSIONS),
) as readonly PluginCapabilityName[];

export type PluginCapabilityName = keyof typeof PLUGIN_CAPABILITY_CONTRACT_VERSIONS;

export type PluginCapabilityContracts = Readonly<Partial<Record<PluginCapabilityName, number>>>;
