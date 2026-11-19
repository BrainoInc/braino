import type { PoolClient } from "@doco/db";
import {
  EMAIL_CAPABILITY_CONTRACT_VERSIONS,
  type EmailCapabilityInput,
  type EmailCapabilityName,
  MODEL_CAPABILITY_CONTRACT_VERSIONS,
  type ModelCapabilityInput,
  type ModelCapabilityName,
  type PluginCapabilityName,
  PluginContractError,
  type PluginManifest,
  TEAM_CHAT_CAPABILITY_CONTRACT_VERSIONS,
  type TeamChatCapabilityInput,
  type TeamChatCapabilityName,
  parseEmailCapabilityInput,
  parseEmailCapabilityOutput,
  parseModelCapabilityInput,
  parseModelCapabilityOutput,
  parsePluginManifest,
  parseTeamChatCapabilityInput,
  parseTeamChatCapabilityOutput,
  pluginProvidesCapability,
} from "@doco/plugin-runtime";
import { PluginInstallationError } from "./plugin-installations.js";
import { openSecret } from "./secret-box.js";

const MAX_HOST_RESPONSE_BYTES = 9 * 1024 * 1024;
type Fetcher = typeof fetch;

interface InvocationRow {
  id: string;
  workspace_id: string;
  manifest: unknown;
  artifact_digest: string;
  configuration: unknown;
  component: Uint8Array;
  sealed_secrets: unknown;
}

export interface PluginHostConnection {
  url: string;
  apiToken: string;
  timeoutMs: number;
}

export function pluginHostConnectionFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): PluginHostConnection | null {
  const url = env.BRAINO_PLUGIN_HOST_URL?.trim();
  const apiToken = env.BRAINO_PLUGIN_HOST_API_TOKEN?.trim();
  const executionTimeoutMs = Number(env.BRAINO_PLUGIN_MAX_EXECUTION_MS ?? "60000");
  if (
    !url ||
    !apiToken ||
    apiToken.length < 32 ||
    !Number.isSafeInteger(executionTimeoutMs) ||
    executionTimeoutMs <= 0
  ) {
    return null;
  }
  return { url, apiToken, timeoutMs: executionTimeoutMs + 5_000 };
}

export class PluginInvocationError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 500,
  ) {
    super(message);
    this.name = "PluginInvocationError";
  }
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginInvocationError(`${label} is invalid.`, "installation_invalid");
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    throw new PluginInvocationError(`${label} is invalid.`, "installation_invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function invocationUrl(host: PluginHostConnection): string {
  if (host.apiToken.trim().length < 32) {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  let base: URL;
  try {
    base = new URL(host.url);
  } catch {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new PluginInvocationError("The plugin host is not configured.", "host_unconfigured");
  }
  return new URL("/v1/invocations", base).toString();
}

function serializedInput(input: unknown): string {
  try {
    const serialized = JSON.stringify(input);
    if (serialized === undefined) throw new Error("not JSON");
    return serialized;
  } catch {
    throw new PluginInvocationError("Plugin input must be JSON.", "input_invalid", 400);
  }
}

function modelCapability(value: PluginCapabilityName): value is ModelCapabilityName {
  return Object.hasOwn(MODEL_CAPABILITY_CONTRACT_VERSIONS, value);
}

function emailCapability(value: PluginCapabilityName): value is EmailCapabilityName {
  return Object.hasOwn(EMAIL_CAPABILITY_CONTRACT_VERSIONS, value);
}

function teamChatCapability(value: PluginCapabilityName): value is TeamChatCapabilityName {
  return Object.hasOwn(TEAM_CHAT_CAPABILITY_CONTRACT_VERSIONS, value);
}

function contractInput(capability: PluginCapabilityName, input: unknown): unknown {
  try {
    if (emailCapability(capability)) return parseEmailCapabilityInput(capability, input);
    if (modelCapability(capability)) return parseModelCapabilityInput(capability, input);
    if (teamChatCapability(capability)) return parseTeamChatCapabilityInput(capability, input);
    return input;
  } catch (error) {
    if (error instanceof PluginContractError) {
      throw new PluginInvocationError(error.message, "plugin_input_invalid", 400);
    }
    throw error;
  }
}

function contractOutput(
  capability: PluginCapabilityName,
  output: unknown,
  input: unknown,
): unknown {
  try {
    if (emailCapability(capability)) {
      return parseEmailCapabilityOutput(
        capability,
        output,
        input as EmailCapabilityInput<typeof capability>,
      );
    }
    if (modelCapability(capability)) {
      return parseModelCapabilityOutput(
        capability,
        output,
        input as ModelCapabilityInput<typeof capability>,
      );
    }
    if (teamChatCapability(capability)) {
      return parseTeamChatCapabilityOutput(
        capability,
        output,
        input as TeamChatCapabilityInput<typeof capability>,
      );
    }
    return output;
  } catch (error) {
    if (error instanceof PluginContractError) {
      throw new PluginInvocationError(error.message, "plugin_output_invalid", 502);
    }
    throw error;
  }
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_HOST_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PluginInvocationError(
        "The plugin host response is too large.",
        "host_response_too_large",
        502,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function manifestForCapability(
  value: unknown,
  capability: PluginCapabilityName,
): Readonly<PluginManifest> {
  const manifest = parsePluginManifest(value);
  if (!pluginProvidesCapability(manifest, capability)) {
    throw new PluginInstallationError(
      `Plugin installation is not approved for ${capability}.`,
      "capability_not_approved",
      403,
    );
  }
  return manifest;
}

export async function invokePlugin(
  client: PoolClient,
  input: {
    workspaceId: string;
    installationId: string;
    capability: PluginCapabilityName;
    input: unknown;
    encryptionKey: string;
    host: PluginHostConnection;
    fetcher?: Fetcher;
  },
): Promise<unknown> {
  const canonicalInput = contractInput(input.capability, input.input);
  const found = await client.query<InvocationRow>(
    `SELECT i.id, i.workspace_id, i.manifest, i.artifact_digest,
            i.configuration, a.component,
            COALESCE(
              (SELECT jsonb_object_agg(s.name, s.value_sealed)
                 FROM plugin_installation_secrets s
                WHERE s.installation_id = i.id),
              '{}'::jsonb
            ) AS sealed_secrets
       FROM plugin_installations i
       JOIN plugin_artifacts a ON a.digest = i.artifact_digest
      WHERE i.workspace_id = $1 AND i.id = $2 AND i.enabled`,
    [input.workspaceId, input.installationId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new PluginInstallationError(
      "Plugin installation is unavailable.",
      "installation_unavailable",
      404,
    );
  }

  const manifest = manifestForCapability(row.manifest, input.capability);
  const configuration = stringRecord(row.configuration, "Plugin configuration");
  const sealedSecrets = stringRecord(row.sealed_secrets, "Plugin secrets");
  const secrets = Object.fromEntries(
    Object.entries(sealedSecrets).map(([name, sealed]) => [
      name,
      openSecret(sealed, input.encryptionKey),
    ]),
  );
  const fetcher = input.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(invocationUrl(input.host), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.host.apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workspaceId: row.workspace_id,
        installationId: row.id,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        artifactDigest: row.artifact_digest,
        componentBase64: Buffer.from(row.component).toString("base64"),
        capability: input.capability,
        inputJson: serializedInput(canonicalInput),
        configuration,
        secrets,
        networkHosts: manifest.permissions.network,
      }),
      signal: AbortSignal.timeout(input.host.timeoutMs),
    });
  } catch (error) {
    if (error instanceof PluginInvocationError) throw error;
    throw new PluginInvocationError("The plugin host is unavailable.", "host_unavailable", 502);
  }

  const text = await responseText(response);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PluginInvocationError(
      "The plugin host returned an invalid response.",
      "host_response_invalid",
      502,
    );
  }
  if (!response.ok) {
    const hostCode =
      body &&
      typeof body === "object" &&
      "error" in body &&
      body.error &&
      typeof body.error === "object" &&
      "code" in body.error &&
      typeof body.error.code === "string"
        ? body.error.code
        : "execution_failed";
    throw new PluginInvocationError("Plugin execution failed.", hostCode, response.status);
  }
  if (
    !body ||
    typeof body !== "object" ||
    !("outputJson" in body) ||
    typeof body.outputJson !== "string"
  ) {
    throw new PluginInvocationError(
      "The plugin host returned an invalid response.",
      "host_response_invalid",
      502,
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(body.outputJson);
  } catch {
    throw new PluginInvocationError(
      "The plugin host returned invalid plugin output.",
      "plugin_output_invalid",
      502,
    );
  }
  return contractOutput(input.capability, output, canonicalInput);
}
