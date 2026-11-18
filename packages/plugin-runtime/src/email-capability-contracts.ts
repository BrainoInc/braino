import { PLUGIN_CAPABILITY_CONTRACT_VERSIONS } from "./capabilities.js";
import { PluginContractError } from "./model-capability-contracts.js";

export const EMAIL_CAPABILITY_CONTRACT_VERSIONS = {
  "email.send": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["email.send"],
} as const;

export type EmailCapabilityName = keyof typeof EMAIL_CAPABILITY_CONTRACT_VERSIONS;

/** Provider-neutral message. The installed plugin owns the sender identity. */
export interface EmailMessage {
  to: readonly string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: readonly string[];
}

export interface EmailSendResponse {
  externalId: string;
}

export interface EmailSendCapability {
  send(input: EmailMessage): Promise<EmailSendResponse>;
}

export interface EmailCapabilityContracts {
  "email.send": { input: EmailMessage; output: EmailSendResponse };
}

export type EmailCapabilityInput<K extends EmailCapabilityName> =
  EmailCapabilityContracts[K]["input"];
export type EmailCapabilityOutput<K extends EmailCapabilityName> =
  EmailCapabilityContracts[K]["output"];

function object(value: unknown, label: string, direction: "input" | "output") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PluginContractError(`${label} must be an object.`, direction);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  direction: "input" | "output",
) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new PluginContractError(`${label} contains unknown field ${unknown}.`, direction);
  }
}

function text(value: unknown, label: string, direction: "input" | "output"): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginContractError(`${label} is invalid.`, direction);
  }
  return value.trim();
}

function email(value: unknown, label: string): string {
  const normalized = text(value, label, "input");
  const displayAddress = normalized.match(/<([^<>]+)>$/)?.[1]?.trim();
  const address = displayAddress ?? normalized;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    throw new PluginContractError(`${label} is invalid.`, "input");
  }
  return normalized;
}

function addresses(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PluginContractError(`${label} must contain at least one recipient.`, "input");
  }
  return value.map((address, index) => email(address, `${label} recipient ${index}`));
}

function optionalAddresses(value: unknown): readonly string[] | undefined {
  return value === undefined ? undefined : addresses(value, "Email replyTo");
}

function optionalBody(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginContractError(`${label} is invalid.`, "input");
  }
  return value;
}

function parseSendInput(value: unknown): EmailMessage {
  const input = object(value, "Email input", "input");
  exactKeys(input, ["to", "subject", "text", "html", "replyTo"], "Email input", "input");
  const bodyText = optionalBody(input.text, "Email text");
  const html = optionalBody(input.html, "Email HTML");
  if (!bodyText && !html) {
    throw new PluginContractError("Email must contain text or HTML.", "input");
  }
  const replyTo = optionalAddresses(input.replyTo);
  return {
    to: addresses(input.to, "Email to"),
    subject: text(input.subject, "Email subject", "input"),
    ...(bodyText ? { text: bodyText } : {}),
    ...(html ? { html } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
}

function parseSendOutput(value: unknown): EmailSendResponse {
  const output = object(value, "Email output", "output");
  exactKeys(output, ["externalId"], "Email output", "output");
  return { externalId: text(output.externalId, "Email externalId", "output") };
}

export function parseEmailCapabilityInput<K extends EmailCapabilityName>(
  _capability: K,
  value: unknown,
): EmailCapabilityInput<K> {
  return parseSendInput(value) as EmailCapabilityInput<K>;
}

export function parseEmailCapabilityOutput<K extends EmailCapabilityName>(
  _capability: K,
  value: unknown,
  _request: EmailCapabilityInput<K>,
): EmailCapabilityOutput<K> {
  return parseSendOutput(value) as EmailCapabilityOutput<K>;
}
