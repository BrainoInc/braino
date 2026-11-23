import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bundledModelPlugin,
  bundledModelPluginCatalog,
  bundledPlugin,
} from "~/lib/bundled-model-plugins.server";
import {
  type InstalledModelPlugin,
  includedWithBraino,
  modelPluginEntry,
  modelSteps,
  preselectedPlugin,
} from "~/lib/model-plugin-catalog";

const plugins = resolve(import.meta.dirname, "../../../../../plugins");

function manifest(directory: string): unknown {
  return JSON.parse(readFileSync(resolve(plugins, directory, "manifest.json"), "utf8"));
}

/** A bundle laid out as the image lays it out: braino_<name>.manifest.json beside braino_<name>.wasm. */
function bundle(): string {
  const directory = mkdtempSync(join(tmpdir(), "braino-plugin-bundle-"));
  for (const plugin of readdirSync(plugins)) {
    const stem = `braino_${plugin.replace("-", "_")}`;
    writeFileSync(join(directory, `${stem}.manifest.json`), JSON.stringify(manifest(plugin)));
    writeFileSync(join(directory, `${stem}.wasm`), `component of ${plugin}`);
  }
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the model plugin catalogue", () => {
  it("describes each bundled plugin from its own manifest", () => {
    expect(modelPluginEntry(manifest("ollama-chat"))).toEqual({
      id: "braino.ollama-chat",
      name: "Ollama chat",
      kind: "chat",
      networkHosts: ["ollama:11434"],
      local: true,
      requiredSecrets: [],
      defaultModel: "qwen3.5:4b",
      suggestedModels: ["qwen3.5:4b", "qwen3.5:2b", "qwen3.5:9b"],
    });
    expect(modelPluginEntry(manifest("ollama-embedding"))).toMatchObject({
      id: "braino.ollama-embedding",
      kind: "embedding",
      local: true,
      requiredSecrets: [],
      defaultModel: "embeddinggemma-2:270m",
    });
    expect(modelPluginEntry(manifest("openai-chat"))).toMatchObject({
      id: "braino.openai-chat",
      name: "OpenAI chat",
      kind: "chat",
      networkHosts: ["api.openai.com"],
      local: false,
      requiredSecrets: ["api_key"],
      defaultModel: "gpt-4.1-mini",
    });
    expect(modelPluginEntry(manifest("openai-embedding"))).toMatchObject({
      id: "braino.openai-embedding",
      name: "OpenAI embeddings",
      kind: "embedding",
      local: false,
      requiredSecrets: ["api_key"],
      defaultModel: "text-embedding-3-small",
    });
  });

  it("offers each plugin's default model first among its suggestions", () => {
    for (const plugin of readdirSync(plugins)) {
      const entry = modelPluginEntry(manifest(plugin));
      expect(entry?.suggestedModels[0]).toBe(entry?.defaultModel);
    }
  });

  it("leaves out plugins that are not one model's provider", () => {
    const base = {
      protocolVersion: 2,
      id: "acme.plugin",
      name: "Acme",
      version: "1.0.0",
      permissions: { network: [] },
      configurationSchema: { properties: { model: { type: "string", default: "small" } } },
    };
    expect(modelPluginEntry({ ...base, capabilities: { "email.send": 1 } })).toBeNull();
    expect(
      modelPluginEntry({
        ...base,
        capabilities: { "chat.complete": 1, "embedding.embed": 1 },
      }),
    ).toBeNull();
    expect(
      modelPluginEntry({
        ...base,
        capabilities: { "chat.complete": 1 },
        configurationSchema: {},
      }),
    ).toBeNull();
    expect(modelPluginEntry({ ...base, capabilities: { "chat.complete": 1 } })).toMatchObject({
      kind: "chat",
      defaultModel: "small",
    });
  });

  it("reads the catalogue from the bundle, with the plugins included with Braino first", async () => {
    vi.stubEnv("BRAINO_PLUGIN_BUNDLE_DIR", bundle());

    const catalog = await bundledModelPluginCatalog();

    expect(catalog.map((entry) => [entry.id, includedWithBraino(entry)])).toEqual([
      ["braino.ollama-chat", true],
      ["braino.ollama-embedding", true],
      ["braino.openai-chat", false],
      ["braino.openai-embedding", false],
    ]);
    expect(preselectedPlugin(catalog, "chat")?.id).toBe("braino.ollama-chat");
    expect(preselectedPlugin(catalog, "embedding")?.id).toBe("braino.ollama-embedding");
  });

  it("loads one bundled plugin by its identifier, with its own component", async () => {
    vi.stubEnv("BRAINO_PLUGIN_BUNDLE_DIR", bundle());

    const plugin = await bundledModelPlugin("braino.openai-embedding");

    expect(plugin?.entry.id).toBe("braino.openai-embedding");
    expect(plugin?.manifest).toEqual(manifest("openai-embedding"));
    expect(Buffer.from(plugin?.component ?? []).toString()).toBe("component of openai-embedding");
    await expect(bundledModelPlugin("braino.unknown")).resolves.toBeNull();
  });

  it("loads non-model plugins through the same bundle boundary", async () => {
    vi.stubEnv("BRAINO_PLUGIN_BUNDLE_DIR", bundle());

    const plugin = await bundledPlugin("braino.slack");

    expect(plugin?.manifest).toEqual(manifest("slack"));
    expect(Buffer.from(plugin?.component ?? []).toString()).toBe("component of slack");
  });

  it("has no bundled plugins when the deployment has no bundle", async () => {
    vi.stubEnv("BRAINO_PLUGIN_BUNDLE_DIR", join(tmpdir(), "braino-no-such-bundle"));

    await expect(bundledModelPluginCatalog()).resolves.toEqual([]);
    await expect(bundledModelPlugin("braino.ollama-chat")).resolves.toBeNull();
  });
});

describe("the two model setup steps", () => {
  const catalog = ["ollama-chat", "ollama-embedding", "openai-chat", "openai-embedding"]
    .map((plugin) => modelPluginEntry(manifest(plugin)))
    .filter((entry) => entry !== null);

  const installed = (
    pluginId: string,
    kind: "chat" | "embedding",
    configuration: Record<string, string>,
    extra: Partial<InstalledModelPlugin> = {},
  ): InstalledModelPlugin => ({
    installationId: `installation_${pluginId}`,
    pluginId,
    name: catalog.find((entry) => entry.id === pluginId)?.name ?? pluginId,
    kind,
    active: true,
    verified: true,
    configuration,
    secretNames: [],
    ...extra,
  });

  it("pre-selects the included plugins with their default models on a fresh workspace", () => {
    expect(modelSteps({ chat: "missing", embedding: "missing" }, catalog, [])).toEqual([
      {
        kind: "chat",
        status: "preselected",
        pluginId: "braino.ollama-chat",
        pluginName: "Ollama chat",
        model: "qwen3.5:4b",
        usesDefault: true,
        usesOwnKey: false,
      },
      {
        kind: "embedding",
        status: "preselected",
        pluginId: "braino.ollama-embedding",
        pluginName: "Ollama embeddings",
        model: "embeddinggemma-2:270m",
        usesDefault: true,
        usesOwnKey: false,
      },
    ]);
  });

  it("shows the one assigned plugin of each model, whichever plugins are merely installed", () => {
    const steps = modelSteps({ chat: "ready", embedding: "ready" }, catalog, [
      installed("braino.ollama-chat", "chat", { model: "qwen3.5:2b" }, { active: false }),
      installed("braino.openai-chat", "chat", { model: "gpt-4.1" }, { secretNames: ["api_key"] }),
      installed("braino.ollama-embedding", "embedding", {
        model: "embeddinggemma-2:270m",
      }),
    ]);

    expect(steps).toEqual([
      {
        kind: "chat",
        status: "ready",
        pluginId: "braino.openai-chat",
        pluginName: "OpenAI chat",
        model: "gpt-4.1",
        usesDefault: false,
        usesOwnKey: true,
      },
      {
        kind: "embedding",
        status: "ready",
        pluginId: "braino.ollama-embedding",
        pluginName: "Ollama embeddings",
        model: "embeddinggemma-2:270m",
        usesDefault: true,
        usesOwnKey: false,
      },
    ]);
  });

  it("shows the selected plugin when its verification needs attention", () => {
    const steps = modelSteps({ chat: "unverified", embedding: "invalid" }, catalog, [
      installed("braino.ollama-chat", "chat", { model: "qwen3.5:2b" }, { active: false }),
      installed("braino.openai-chat", "chat", { model: "gpt-4.1-mini" }),
      installed("braino.openai-embedding", "embedding", { model: "text-embedding-3-small" }),
    ]);

    expect(steps[0]).toMatchObject({
      status: "unverified",
      pluginId: "braino.openai-chat",
      model: "gpt-4.1-mini",
    });
    expect(steps[1]).toMatchObject({
      status: "invalid",
      pluginId: "braino.openai-embedding",
      usesDefault: false,
    });
  });
});
