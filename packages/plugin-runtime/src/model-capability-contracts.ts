import { PLUGIN_CAPABILITY_CONTRACT_VERSIONS } from "./capabilities.js";

/**
 * Model capability contracts are provider-neutral and versioned independently.
 * A plugin owns provider choices such as model names, credentials and endpoints;
 * Braino sends only these canonical requests and accepts only these responses.
 */
export const MODEL_CAPABILITY_CONTRACT_VERSIONS = {
  "chat.complete": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["chat.complete"],
  "embedding.embed": PLUGIN_CAPABILITY_CONTRACT_VERSIONS["embedding.embed"],
} as const;

export type ModelCapabilityName = keyof typeof MODEL_CAPABILITY_CONTRACT_VERSIONS;

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompleteRequest {
  messages: readonly ChatMessage[];
  responseSchema?: Readonly<Record<string, unknown>>;
}

export interface ChatCompleteResponse {
  content: string;
  model: string;
}

export interface ChatCompleteCapability {
  complete(input: ChatCompleteRequest): Promise<ChatCompleteResponse>;
}

export type EmbeddingInputType = "document" | "query";

export interface EmbeddingRequest {
  inputs: readonly string[];
  inputType?: EmbeddingInputType;
}

export interface EmbeddingResponse {
  model: string;
  dimensions: number;
  vectors: readonly (readonly number[])[];
}

export interface EmbeddingCapability {
  embed(input: EmbeddingRequest): Promise<EmbeddingResponse>;
}

export interface ModelCapabilityContracts {
  "chat.complete": { input: ChatCompleteRequest; output: ChatCompleteResponse };
  "embedding.embed": { input: EmbeddingRequest; output: EmbeddingResponse };
}

export type ModelCapabilityInput<K extends ModelCapabilityName> =
  ModelCapabilityContracts[K]["input"];

export type ModelCapabilityOutput<K extends ModelCapabilityName> =
  ModelCapabilityContracts[K]["output"];

export class PluginContractError extends Error {
  constructor(
    message: string,
    public readonly direction: "input" | "output",
  ) {
    super(message);
    this.name = "PluginContractError";
  }
}

function contractObject(
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

function usableText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseChatInput(value: unknown): ChatCompleteRequest {
  const input = contractObject(value, "Chat input", "input");
  exactKeys(input, ["messages", "responseSchema"], "Chat input", "input");
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new PluginContractError("Chat messages must be a non-empty array.", "input");
  }
  const messages = input.messages.map((value, index): ChatMessage => {
    const message = contractObject(value, `Chat message ${index}`, "input");
    exactKeys(message, ["role", "content"], `Chat message ${index}`, "input");
    if (!(["system", "user", "assistant", "tool"] as const).includes(message.role as ChatRole)) {
      throw new PluginContractError(`Chat message ${index} role is invalid.`, "input");
    }
    if (!usableText(message.content)) {
      throw new PluginContractError(`Chat message ${index} content is invalid.`, "input");
    }
    return { role: message.role as ChatRole, content: message.content };
  });
  const responseSchema =
    input.responseSchema === undefined
      ? undefined
      : contractObject(input.responseSchema, "Chat responseSchema", "input");
  return {
    messages,
    ...(responseSchema ? { responseSchema } : {}),
  };
}

function parseEmbeddingInput(value: unknown): EmbeddingRequest {
  const input = contractObject(value, "Embedding input", "input");
  exactKeys(input, ["inputs", "inputType"], "Embedding input", "input");
  if (
    !Array.isArray(input.inputs) ||
    input.inputs.length === 0 ||
    input.inputs.some((text) => !usableText(text))
  ) {
    throw new PluginContractError("Embedding inputs must be non-empty strings.", "input");
  }
  if (
    input.inputType !== undefined &&
    input.inputType !== "document" &&
    input.inputType !== "query"
  ) {
    throw new PluginContractError("Embedding inputType is invalid.", "input");
  }
  return {
    inputs: input.inputs as string[],
    ...(input.inputType ? { inputType: input.inputType } : {}),
  };
}

function parseChatOutput(value: unknown): ChatCompleteResponse {
  const output = contractObject(value, "Chat output", "output");
  exactKeys(output, ["content", "model"], "Chat output", "output");
  if (!usableText(output.content)) {
    throw new PluginContractError("Chat output content is invalid.", "output");
  }
  if (!usableText(output.model)) {
    throw new PluginContractError("Chat output model is invalid.", "output");
  }
  return { content: output.content, model: output.model };
}

function parseEmbeddingOutput(value: unknown, request: EmbeddingRequest): EmbeddingResponse {
  const output = contractObject(value, "Embedding output", "output");
  exactKeys(output, ["model", "dimensions", "vectors"], "Embedding output", "output");
  if (!usableText(output.model)) {
    throw new PluginContractError("Embedding output model is invalid.", "output");
  }
  if (!Number.isInteger(output.dimensions) || Number(output.dimensions) < 1) {
    throw new PluginContractError("Embedding output dimensions are invalid.", "output");
  }
  if (!Array.isArray(output.vectors) || output.vectors.length !== request.inputs.length) {
    throw new PluginContractError("Embedding output vector count is invalid.", "output");
  }
  const dimensions = Number(output.dimensions);
  const vectors = output.vectors.map((value, index): number[] => {
    if (!Array.isArray(value) || value.length !== dimensions) {
      throw new PluginContractError(
        `Embedding output vector ${index} dimensions are invalid.`,
        "output",
      );
    }
    if (value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
      throw new PluginContractError(
        `Embedding output vector ${index} must contain finite numbers.`,
        "output",
      );
    }
    return value as number[];
  });
  return { model: output.model, dimensions, vectors };
}

export function parseModelCapabilityInput<K extends ModelCapabilityName>(
  capability: K,
  value: unknown,
): ModelCapabilityInput<K> {
  return (
    capability === "chat.complete" ? parseChatInput(value) : parseEmbeddingInput(value)
  ) as ModelCapabilityInput<K>;
}

export function parseModelCapabilityOutput<K extends ModelCapabilityName>(
  capability: K,
  value: unknown,
  request: ModelCapabilityInput<K>,
): ModelCapabilityOutput<K> {
  return (
    capability === "chat.complete"
      ? parseChatOutput(value)
      : parseEmbeddingOutput(value, request as EmbeddingRequest)
  ) as ModelCapabilityOutput<K>;
}
