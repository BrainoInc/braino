import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  PLUGIN_PROTOCOL_VERSION,
  type SourcePullCapability,
  definePlugin,
  parsePluginManifest,
  pluginCapability,
  pluginConfigurationChoices,
} from "../index.js";

const sourcePull: SourcePullCapability = {
  provider: "slack",
  async verify() {
    return { id: "T_ACME", name: "Acme" };
  },
  async *documents() {
    yield {
      externalId: "message-1",
      title: "Announcement",
      content: "Launch is Monday",
      url: "https://acme.slack.com/archives/general/message-1",
      updatedAt: "2026-11-13T00:00:00.000Z",
    };
  },
};

function sourcePlugin() {
  return definePlugin({
    manifest: {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      id: "braino.slack",
      name: "Slack",
      version: "1.0.0",
      capabilities: { "source.pull": 1 },
      permissions: { network: ["slack.com", "*.slack.com"] },
    },
    capabilities: { "source.pull": sourcePull },
  });
}

describe("Braino plugin protocol", () => {
  it("versions source-control checks and enforcement at the host boundary", () => {
    const manifest = parsePluginManifest({
      protocolVersion: 2,
      id: "braino.github",
      name: "GitHub",
      version: "1.0.0",
      capabilities: {
        "event.receive": 1,
        "scm.check.publish": 1,
        "scm.ruleset.reconcile": 1,
      },
      permissions: { network: ["api.github.com"] },
    });

    expect(manifest.capabilities).toEqual({
      "event.receive": 1,
      "scm.check.publish": 1,
      "scm.ruleset.reconcile": 1,
    });
  });

  it("ships one canonical WASI component world with the runtime package", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown>; files: string[] };
    const wit = readFileSync(new URL("../../wit/plugin.wit", import.meta.url), "utf8");

    expect(packageJson.files).toContain("wit");
    expect(packageJson.exports).toHaveProperty("./wit/plugin.wit");
    expect(wit).toContain("package braino:plugin@0.1.0;");
    expect(wit).toContain("import host;");
    expect(wit).toContain("export handler;");
  });

  it("carries connector failures across the host boundary", () => {
    const error = new ConnectorError("Provider unavailable.", "provider_unavailable", 502);

    expect(error).toMatchObject({
      name: "ConnectorError",
      message: "Provider unavailable.",
      code: "provider_unavailable",
      status: 502,
    });
  });

  it("defines an immutable, versioned plugin with matching capabilities", () => {
    const plugin = sourcePlugin();

    expect(plugin.manifest).toMatchObject({
      protocolVersion: 2,
      id: "braino.slack",
      capabilities: { "source.pull": 1 },
    });
    expect(pluginCapability(plugin, "source.pull")).toBe(sourcePull);
    expect(Object.isFrozen(plugin)).toBe(true);
    expect(Object.isFrozen(plugin.manifest)).toBe(true);
  });

  it("parses an untrusted marketplace manifest into the canonical immutable shape", () => {
    const manifest = parsePluginManifest({
      protocolVersion: 2,
      id: "acme.private-plugin",
      name: "Private plugin",
      version: "2.3.4",
      capabilities: { "email.send": 1 },
      permissions: { network: ["api.example.com:443"] },
      configurationSchema: { type: "object" },
      secretSchema: { type: "object" },
    });

    expect(manifest).toMatchObject({
      id: "acme.private-plugin",
      capabilities: { "email.send": 1 },
      permissions: { network: ["api.example.com:443"] },
    });
    expect(Object.isFrozen(manifest.capabilities)).toBe(true);
    expect(Object.isFrozen(manifest.permissions.network)).toBe(true);
  });

  it.each([
    [null, "object"],
    [{}, "protocol version"],
    [
      {
        protocolVersion: 2,
        id: "braino.slack",
        name: "Slack",
        version: "1.0.0",
        capabilities: "source.pull",
        permissions: { network: ["slack.com"] },
      },
      "capabilities",
    ],
    [
      {
        protocolVersion: 2,
        id: "braino.slack",
        name: "Slack",
        version: "1.0.0",
        capabilities: { "source.pull": 1 },
        permissions: { network: "slack.com" },
      },
      "network permissions",
    ],
  ])("rejects malformed marketplace manifest input", (input, message) => {
    expect(() => parsePluginManifest(input)).toThrow(message);
  });

  const modelManifest = (model: Record<string, unknown>) => ({
    protocolVersion: 2,
    id: "acme.chat",
    name: "Acme chat",
    version: "1.0.0",
    capabilities: { "chat.complete": 1 },
    permissions: { network: ["api.example.com"] },
    configurationSchema: {
      type: "object",
      properties: { model: { type: "string", ...model }, region: { type: "string" } },
    },
  });

  it("reads the default and suggested values a manifest declares for a configuration key", () => {
    const manifest = parsePluginManifest(
      modelManifest({ default: "small", examples: ["large", "small", "medium"] }),
    );

    expect(pluginConfigurationChoices(manifest, "model")).toEqual({
      default: "small",
      suggested: ["small", "large", "medium"],
    });
    expect(pluginConfigurationChoices(manifest, "region")).toEqual({
      default: null,
      suggested: [],
    });
    expect(pluginConfigurationChoices(manifest, "undeclared")).toEqual({
      default: null,
      suggested: [],
    });
    expect(
      pluginConfigurationChoices(parsePluginManifest(modelManifest({ default: "small" })), "model"),
    ).toEqual({ default: "small", suggested: ["small"] });
  });

  it.each([
    [{ default: 4 }, "default"],
    [{ default: " " }, "default"],
    [{ examples: "large" }, "examples"],
    [{ examples: ["large", 4] }, "examples"],
    [{ examples: ["large", ""] }, "examples"],
    [{ examples: ["large", "large"] }, "examples"],
  ])("rejects a configuration default or suggestion that is not usable text", (model, message) => {
    expect(() => parsePluginManifest(modelManifest(model))).toThrow(
      `Plugin configuration property model has invalid ${message}.`,
    );
  });

  it("rejects a manifest whose implementation does not match its declaration", () => {
    expect(() =>
      definePlugin({
        manifest: {
          protocolVersion: PLUGIN_PROTOCOL_VERSION,
          id: "braino.slack",
          name: "Slack",
          version: "1.0.0",
          capabilities: { "source.pull": 1, "event.receive": 1 },
          permissions: { network: ["slack.com"] },
        },
        capabilities: { "source.pull": sourcePull },
      }),
    ).toThrow("event.receive");
  });

  it("rejects undeclared implementations and missing capability lookups", () => {
    expect(() =>
      definePlugin({
        manifest: {
          protocolVersion: PLUGIN_PROTOCOL_VERSION,
          id: "braino.slack",
          name: "Slack",
          version: "1.0.0",
          capabilities: { "source.pull": 1 },
          permissions: { network: ["slack.com"] },
        },
        capabilities: {
          "source.pull": sourcePull,
          "event.receive": {
            async receive() {
              return [];
            },
          },
        },
      }),
    ).toThrow("undeclared capability");

    expect(() => pluginCapability(sourcePlugin(), "event.receive")).toThrow(
      "does not provide event.receive",
    );
  });

  it.each([
    [{ protocolVersion: 1 }, "protocol version"],
    [{ id: "Slack" }, "identifier"],
    [{ version: "latest" }, "semantic version"],
    [{ name: " " }, "name is required"],
    [{ capabilities: {} }, "at least one capability"],
    [{ capabilities: { "unknown.capability": 1 } }, "Unknown plugin capability"],
    [{ capabilities: { "source.pull": 2 } }, "contract version"],
    [{ permissions: { network: ["https://slack.com/api"] } }, "network host"],
  ])("rejects an unsafe or incompatible manifest override", (override, message) => {
    const manifest = {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      id: "braino.slack",
      name: "Slack",
      version: "1.0.0",
      capabilities: { "source.pull": 1 } as const,
      permissions: { network: ["slack.com"] },
      ...override,
    };

    expect(() =>
      definePlugin({
        // This cast exercises runtime validation of untrusted marketplace input.
        manifest: manifest as never,
        capabilities: { "source.pull": sourcePull },
      }),
    ).toThrow(message);
  });
});
