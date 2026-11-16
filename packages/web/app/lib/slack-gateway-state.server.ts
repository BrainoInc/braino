import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

interface SlackGatewayState {
  userId: string;
  workspaceId: string;
  nonce: string;
  issuedAt: number;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createSlackGatewayState(
  input: { userId: string; workspaceId: string },
  secret: string,
  now = Date.now(),
): string {
  const state: SlackGatewayState = {
    ...input,
    nonce: randomBytes(16).toString("base64url"),
    issuedAt: now,
  };
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySlackGatewayState(
  value: string,
  secret: string,
  now = Date.now(),
): { userId: string; workspaceId: string } {
  const [payload, supplied] = value.split(".");
  if (!payload || !supplied || !equal(supplied, signature(payload, secret))) {
    throw new Error("Slack gateway state is invalid.");
  }
  let state: SlackGatewayState;
  try {
    state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SlackGatewayState;
  } catch {
    throw new Error("Slack gateway state is invalid.");
  }
  if (!state.userId || !state.workspaceId || !state.nonce || typeof state.issuedAt !== "number") {
    throw new Error("Slack gateway state is invalid.");
  }
  if (now - state.issuedAt > STATE_TTL_MS || state.issuedAt - now > 60_000) {
    throw new Error("Slack gateway state expired.");
  }
  return { userId: state.userId, workspaceId: state.workspaceId };
}

export function brainoPluginGatewayUrl(): string {
  const configured = process.env.BRAINO_PLUGIN_GATEWAY_URL?.trim() || "https://plugins.braino.dev";
  const url = new URL(configured);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BRAINO_PLUGIN_GATEWAY_URL must be an HTTPS origin.");
  }
  return url.origin;
}
