import {
  PLUGIN_CAPABILITIES,
  PLUGIN_CAPABILITY_CONTRACT_VERSIONS,
  type PluginCapabilityContracts,
  type PluginCapabilityName,
} from "./capabilities.js";
import type { EmailSendCapability } from "./email-capability-contracts.js";
import type { ChatCompleteCapability, EmbeddingCapability } from "./model-capability-contracts.js";
import type {
  EventReceiveCapability,
  TeamChatConnectCapability,
  TeamChatSendCapability,
} from "./team-chat-capability-contracts.js";

export * from "./capabilities.js";
export * from "./email-capability-contracts.js";
export * from "./model-capability-contracts.js";
export * from "./team-chat-capability-contracts.js";

export const PLUGIN_PROTOCOL_VERSION = 2 as const;

export type ConnectorFetcher = typeof fetch;

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface ConnectorSource {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface ConnectorDocument {
  externalId: string;
  title: string;
  content: string;
  url: string;
  createdAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface SourcePullCapability {
  provider: string;
  collectionTemplate: string;
  verify(input: { credential: string; fetcher: ConnectorFetcher }): Promise<ConnectorSource>;
  documents(input: {
    credential: string;
    source: ConnectorSource;
    fetcher: ConnectorFetcher;
  }): AsyncIterable<ConnectorDocument>;
}

/** Existing connector consumers use this name; it is the source.pull capability. */
export type ConnectorAdapter = SourcePullCapability;

export interface ScmRequestInput {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}

export interface ScmRequestOutput {
  data: unknown;
  next: string | null;
}

export interface ScmRequestCapability {
  request(input: ScmRequestInput): Promise<ScmRequestOutput>;
}

export type ScmCheckConclusion = "success" | "failure" | "neutral";

export interface ScmCheckPublishInput {
  repository: string;
  name: string;
  headSha: string;
  conclusion: ScmCheckConclusion;
  title: string;
  summary: string;
  detailsUrl?: string;
}

export interface ScmCheckPublishCapability {
  publish(input: ScmCheckPublishInput): Promise<{ id: number }>;
}

export interface ScmReviewRejectInput {
  repository: string;
  pullNumber: number;
  body: string;
  commitId?: string;
}

export interface ScmReviewRejectCapability {
  reject(input: ScmReviewRejectInput): Promise<{ id: number }>;
}

export interface PluginCapabilityImplementations {
  "source.pull": SourcePullCapability;
  "event.receive": EventReceiveCapability;
  "email.send": EmailSendCapability;
  "team_chat.connect": TeamChatConnectCapability;
  "team_chat.send": TeamChatSendCapability;
  "embedding.embed": EmbeddingCapability;
  "chat.complete": ChatCompleteCapability;
  "scm.request": ScmRequestCapability;
  "scm.check.publish": ScmCheckPublishCapability;
  "scm.review.reject": ScmReviewRejectCapability;
}

export type PluginImplementations = Partial<PluginCapabilityImplementations>;

export interface PluginManifest {
  protocolVersion: typeof PLUGIN_PROTOCOL_VERSION;
  id: string;
  name: string;
  version: string;
  capabilities: PluginCapabilityContracts;
  permissions: {
    network: readonly string[];
  };
  configurationSchema?: Readonly<Record<string, unknown>>;
  secretSchema?: Readonly<Record<string, unknown>>;
}

export interface BrainoPlugin {
  readonly manifest: Readonly<PluginManifest>;
  readonly capabilities: Readonly<PluginImplementations>;
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NETWORK_HOST = /^(?:\*\.)?(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/;
const KNOWN_CAPABILITIES = new Set<string>(PLUGIN_CAPABILITIES);

function validateManifest(manifest: PluginManifest): void {
  if (manifest.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    throw new Error(`Unsupported plugin protocol version: ${manifest.protocolVersion}.`);
  }
  if (!PLUGIN_ID.test(manifest.id)) {
    throw new Error("Plugin identifier must be lowercase and dot- or dash-separated.");
  }
  if (!manifest.name.trim()) throw new Error("Plugin name is required.");
  if (!SEMANTIC_VERSION.test(manifest.version)) {
    throw new Error("Plugin version must be a semantic version.");
  }
  const capabilities = Object.entries(manifest.capabilities);
  if (capabilities.length === 0) {
    throw new Error("A plugin must declare at least one capability.");
  }
  for (const [capability, version] of capabilities) {
    if (!KNOWN_CAPABILITIES.has(capability)) {
      throw new Error(`Unknown plugin capability: ${capability}.`);
    }
    const supported = PLUGIN_CAPABILITY_CONTRACT_VERSIONS[capability as PluginCapabilityName];
    if (version !== supported) {
      throw new Error(
        `Unsupported ${capability} contract version: ${String(version)}; expected ${supported}.`,
      );
    }
  }
  for (const host of manifest.permissions.network) {
    if (!NETWORK_HOST.test(host) || host === "*") {
      throw new Error(`Invalid plugin network host: ${host}.`);
    }
  }
  for (const [key, property] of Object.entries(schemaProperties(manifest.configurationSchema))) {
    // Configuration values are strings, so what a manifest offers for one must be too.
    if (property.default !== undefined && !usableText(property.default)) {
      throw new Error(`Plugin configuration property ${key} has invalid default.`);
    }
    const examples = property.examples;
    if (
      examples !== undefined &&
      (!Array.isArray(examples) ||
        !examples.every(usableText) ||
        new Set(examples).size !== examples.length)
    ) {
      throw new Error(`Plugin configuration property ${key} has invalid examples.`);
    }
  }
}

function usableText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function schemaProperties(
  schema: Readonly<Record<string, unknown>> | undefined,
): Record<string, Record<string, unknown>> {
  const properties = schema?.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
    ),
  );
}

/**
 * What a manifest offers for one configuration key: the JSON Schema `default`
 * of that property, and its `examples` as suggested values, default first.
 */
export function pluginConfigurationChoices(
  manifest: Readonly<PluginManifest>,
  key: string,
): { default: string | null; suggested: readonly string[] } {
  const property = schemaProperties(manifest.configurationSchema)[key];
  const fallback = usableText(property?.default) ? property.default : null;
  const examples = Array.isArray(property?.examples) ? property.examples.filter(usableText) : [];
  return {
    default: fallback,
    suggested: [...new Set(fallback ? [fallback, ...examples] : examples)],
  };
}

function immutableManifest(manifest: PluginManifest): Readonly<PluginManifest> {
  return Object.freeze({
    ...manifest,
    capabilities: Object.freeze({ ...manifest.capabilities }),
    permissions: Object.freeze({
      network: Object.freeze([...manifest.permissions.network]),
    }),
    ...(manifest.configurationSchema
      ? { configurationSchema: Object.freeze({ ...manifest.configurationSchema }) }
      : {}),
    ...(manifest.secretSchema ? { secretSchema: Object.freeze({ ...manifest.secretSchema }) } : {}),
  });
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalSchema(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : objectValue(value, label);
}

export function parsePluginManifest(value: unknown): Readonly<PluginManifest> {
  const input = objectValue(value, "Plugin manifest");
  if (input.protocolVersion !== PLUGIN_PROTOCOL_VERSION) {
    throw new Error(`Unsupported plugin protocol version: ${input.protocolVersion}.`);
  }
  if (typeof input.id !== "string") throw new Error("Plugin identifier must be a string.");
  if (typeof input.name !== "string") throw new Error("Plugin name must be a string.");
  if (typeof input.version !== "string") throw new Error("Plugin version must be a string.");
  const capabilities = objectValue(input.capabilities, "Plugin capabilities");
  const permissions = objectValue(input.permissions, "Plugin permissions");
  if (
    !Array.isArray(permissions.network) ||
    permissions.network.some((item) => typeof item !== "string")
  ) {
    throw new Error("Plugin network permissions must be an array of hosts.");
  }
  const configurationSchema = optionalSchema(
    input.configurationSchema,
    "Plugin configuration schema",
  );
  const secretSchema = optionalSchema(input.secretSchema, "Plugin secret schema");
  const manifest = {
    protocolVersion: input.protocolVersion,
    id: input.id,
    name: input.name,
    version: input.version,
    capabilities,
    permissions: { network: permissions.network },
    ...(configurationSchema ? { configurationSchema } : {}),
    ...(secretSchema ? { secretSchema } : {}),
  } as PluginManifest;
  validateManifest(manifest);
  return immutableManifest(manifest);
}

export function definePlugin(input: {
  manifest: PluginManifest;
  capabilities: PluginImplementations;
}): BrainoPlugin {
  const manifest = parsePluginManifest(input.manifest);
  const declared = new Set<string>(Object.keys(manifest.capabilities));
  const implemented = Object.keys(input.capabilities);
  for (const capability of declared) {
    if (!input.capabilities[capability as PluginCapabilityName]) {
      throw new Error(`Plugin does not implement declared capability: ${capability}.`);
    }
  }
  for (const capability of implemented) {
    if (!declared.has(capability)) {
      throw new Error(`Plugin implements undeclared capability: ${capability}.`);
    }
  }
  return Object.freeze({
    manifest,
    capabilities: Object.freeze({ ...input.capabilities }),
  });
}

export function pluginCapability<K extends PluginCapabilityName>(
  plugin: BrainoPlugin,
  capability: K,
): PluginCapabilityImplementations[K] {
  const implementation = plugin.capabilities[capability];
  if (!implementation) {
    throw new Error(`Plugin ${plugin.manifest.id} does not provide ${capability}.`);
  }
  return implementation as PluginCapabilityImplementations[K];
}

export function pluginProvidesCapability(
  manifest: Readonly<PluginManifest>,
  capability: PluginCapabilityName,
): boolean {
  return manifest.capabilities[capability] === PLUGIN_CAPABILITY_CONTRACT_VERSIONS[capability];
}
