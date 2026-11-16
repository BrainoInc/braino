import { PLUGIN_CAPABILITY_CONTRACT_VERSIONS } from "./capabilities.js";
import { PluginContractError } from "./model-capability-contracts.js";

export const TEAM_CHAT_CAPABILITY_CONTRACT_VERSIONS = {
  "event.receive": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["event.receive"],
  "team_chat.connect": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["team_chat.connect"],
  "team_chat.send": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["team_chat.send"],
} as const;

export type TeamChatCapabilityName = keyof typeof TEAM_CHAT_CAPABILITY_CONTRACT_VERSIONS;

export interface TeamChatConnectRequest {
  installer?: { email?: string };
  introductionChannel?: string;
}

export interface TeamChatChannel {
  id: string;
  name: string;
}

export interface TeamChatConnectResponse {
  externalWorkspaceId: string;
  workspaceName: string;
  botUserId: string;
  installerUserId?: string;
  channels: readonly TeamChatChannel[];
}

export interface PluginEventRequest {
  body: string;
  headers: Readonly<Record<string, string>>;
  receivedAt: number;
}

export interface PluginEvent {
  id: string;
  occurredAt: string;
  kind: string;
  data: Record<string, unknown>;
}

export interface TeamChatTarget {
  kind: "channel" | "user";
  id: string;
}

export interface TeamChatMessage {
  target: TeamChatTarget;
  text: string;
  threadId?: string;
}

export interface TeamChatSendResponse {
  externalId: string;
}

export interface TeamChatConnectCapability {
  connect(input: TeamChatConnectRequest): Promise<TeamChatConnectResponse>;
}

export interface EventReceiveCapability {
  receive(input: PluginEventRequest): Promise<readonly PluginEvent[]>;
}

export interface TeamChatSendCapability {
  send(input: TeamChatMessage): Promise<TeamChatSendResponse>;
}

export interface TeamChatCapabilityContracts {
  "event.receive": { input: PluginEventRequest; output: readonly PluginEvent[] };
  "team_chat.connect": { input: TeamChatConnectRequest; output: TeamChatConnectResponse };
  "team_chat.send": { input: TeamChatMessage; output: TeamChatSendResponse };
}

export type TeamChatCapabilityInput<K extends TeamChatCapabilityName> =
  TeamChatCapabilityContracts[K]["input"];

export type TeamChatCapabilityOutput<K extends TeamChatCapabilityName> =
  TeamChatCapabilityContracts[K]["output"];

function object(
  value: unknown,
  label: string,
  direction: "input" | "output",
): Record<string, unknown> {
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
): void {
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

function optionalText(
  value: unknown,
  label: string,
  direction: "input" | "output",
): string | undefined {
  return value === undefined ? undefined : text(value, label, direction);
}

function parseConnectInput(value: unknown): TeamChatConnectRequest {
  const input = object(value, "Team chat connect input", "input");
  exactKeys(input, ["installer", "introductionChannel"], "Team chat connect input", "input");
  let installer: TeamChatConnectRequest["installer"];
  if (input.installer !== undefined) {
    const raw = object(input.installer, "Team chat installer", "input");
    exactKeys(raw, ["email"], "Team chat installer", "input");
    const email = optionalText(raw.email, "Team chat installer email", "input");
    installer = email ? { email } : {};
  }
  const introductionChannel = optionalText(
    input.introductionChannel,
    "Team chat introductionChannel",
    "input",
  );
  return {
    ...(installer ? { installer } : {}),
    ...(introductionChannel ? { introductionChannel } : {}),
  };
}

function parseEventInput(value: unknown): PluginEventRequest {
  const input = object(value, "Event input", "input");
  exactKeys(input, ["body", "headers", "receivedAt"], "Event input", "input");
  if (typeof input.body !== "string") {
    throw new PluginContractError("Event body must be a string.", "input");
  }
  const rawHeaders = object(input.headers, "Event headers", "input");
  const headers = Object.fromEntries(
    Object.entries(rawHeaders)
      .map(([name, value]) => [name.trim().toLowerCase(), text(value, `Header ${name}`, "input")])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  if (!Number.isInteger(input.receivedAt) || Number(input.receivedAt) < 0) {
    throw new PluginContractError("Event receivedAt is invalid.", "input");
  }
  return { body: input.body, headers, receivedAt: Number(input.receivedAt) };
}

function parseSendInput(value: unknown): TeamChatMessage {
  const input = object(value, "Team chat send input", "input");
  exactKeys(input, ["target", "text", "threadId"], "Team chat send input", "input");
  const rawTarget = object(input.target, "Team chat target", "input");
  exactKeys(rawTarget, ["kind", "id"], "Team chat target", "input");
  if (rawTarget.kind !== "channel" && rawTarget.kind !== "user") {
    throw new PluginContractError("Team chat target kind is invalid.", "input");
  }
  const threadId = optionalText(input.threadId, "Team chat threadId", "input");
  return {
    target: { kind: rawTarget.kind, id: text(rawTarget.id, "Team chat target id", "input") },
    text: text(input.text, "Team chat message text", "input"),
    ...(threadId ? { threadId } : {}),
  };
}

function parseConnectOutput(value: unknown): TeamChatConnectResponse {
  const output = object(value, "Team chat connect output", "output");
  exactKeys(
    output,
    ["externalWorkspaceId", "workspaceName", "botUserId", "installerUserId", "channels"],
    "Team chat connect output",
    "output",
  );
  if (!Array.isArray(output.channels)) {
    throw new PluginContractError("Team chat channels must be an array.", "output");
  }
  const channels = output.channels.map((value, index) => {
    const channel = object(value, `Team chat channel ${index}`, "output");
    exactKeys(channel, ["id", "name"], `Team chat channel ${index}`, "output");
    return {
      id: text(channel.id, `Team chat channel ${index} id`, "output"),
      name: text(channel.name, `Team chat channel ${index} name`, "output"),
    };
  });
  const installerUserId = optionalText(
    output.installerUserId,
    "Team chat installerUserId",
    "output",
  );
  return {
    externalWorkspaceId: text(
      output.externalWorkspaceId,
      "Team chat externalWorkspaceId",
      "output",
    ),
    workspaceName: text(output.workspaceName, "Team chat workspaceName", "output"),
    botUserId: text(output.botUserId, "Team chat botUserId", "output"),
    ...(installerUserId ? { installerUserId } : {}),
    channels,
  };
}

function parseEventData(kind: string, value: unknown, index: number): Record<string, unknown> {
  const data = object(value, `Event ${index} data`, "output");
  if (kind === "webhook.challenge") {
    exactKeys(data, ["challenge"], `Event ${index} data`, "output");
    return { challenge: text(data.challenge, `Event ${index} challenge`, "output") };
  }
  if (kind === "team_chat.uninstalled") {
    exactKeys(data, [], `Event ${index} data`, "output");
    return {};
  }
  if (kind !== "team_chat.message") return data;
  exactKeys(
    data,
    ["channelId", "senderId", "senderEmail", "text", "messageId", "replyThreadId", "direct"],
    `Event ${index} data`,
    "output",
  );
  const senderEmail = text(data.senderEmail, `Event ${index} senderEmail`, "output").toLowerCase();
  if (!senderEmail.includes("@")) {
    throw new PluginContractError(`Event ${index} senderEmail is invalid.`, "output");
  }
  if (typeof data.direct !== "boolean") {
    throw new PluginContractError(`Event ${index} direct is invalid.`, "output");
  }
  const replyThreadId = optionalText(data.replyThreadId, `Event ${index} replyThreadId`, "output");
  return {
    channelId: text(data.channelId, `Event ${index} channelId`, "output"),
    senderId: text(data.senderId, `Event ${index} senderId`, "output"),
    senderEmail,
    text: text(data.text, `Event ${index} text`, "output"),
    messageId: text(data.messageId, `Event ${index} messageId`, "output"),
    ...(replyThreadId ? { replyThreadId } : {}),
    direct: data.direct,
  };
}

function parseEventOutput(value: unknown): readonly PluginEvent[] {
  if (!Array.isArray(value)) {
    throw new PluginContractError("Event output must be an array.", "output");
  }
  return value.map((value, index) => {
    const event = object(value, `Event ${index}`, "output");
    exactKeys(event, ["id", "occurredAt", "kind", "data"], `Event ${index}`, "output");
    const rawOccurredAt = text(event.occurredAt, `Event ${index} occurredAt`, "output");
    const occurredAt = /^\d+$/.test(rawOccurredAt)
      ? new Date(Number(rawOccurredAt) * 1000).toISOString()
      : rawOccurredAt;
    if (Number.isNaN(Date.parse(occurredAt))) {
      throw new PluginContractError(`Event ${index} occurredAt is invalid.`, "output");
    }
    const kind = text(event.kind, `Event ${index} kind`, "output");
    return {
      id: text(event.id, `Event ${index} id`, "output"),
      occurredAt,
      kind,
      data: parseEventData(kind, event.data, index),
    };
  });
}

function parseSendOutput(value: unknown): TeamChatSendResponse {
  const output = object(value, "Team chat send output", "output");
  exactKeys(output, ["externalId"], "Team chat send output", "output");
  return { externalId: text(output.externalId, "Team chat externalId", "output") };
}

export function parseTeamChatCapabilityInput<K extends TeamChatCapabilityName>(
  capability: K,
  value: unknown,
): TeamChatCapabilityInput<K> {
  return (
    capability === "team_chat.connect"
      ? parseConnectInput(value)
      : capability === "event.receive"
        ? parseEventInput(value)
        : parseSendInput(value)
  ) as TeamChatCapabilityInput<K>;
}

export function parseTeamChatCapabilityOutput<K extends TeamChatCapabilityName>(
  capability: K,
  value: unknown,
  _request: TeamChatCapabilityInput<K>,
): TeamChatCapabilityOutput<K> {
  return (
    capability === "team_chat.connect"
      ? parseConnectOutput(value)
      : capability === "event.receive"
        ? parseEventOutput(value)
        : parseSendOutput(value)
  ) as TeamChatCapabilityOutput<K>;
}
