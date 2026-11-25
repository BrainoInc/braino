import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../../../../../");

function runUpgradeWithImages(
  appImage: string,
  codeLinkerImage = "ghcr.io/brainoinc/braino-codelinker:0.1.14",
  pluginHostImage = "ghcr.io/brainoinc/braino-plugin-host:0.1.14",
) {
  const runtime = mkdtempSync(join(tmpdir(), "braino-upgrade-test-"));
  const docker = join(runtime, "docker");
  const log = join(runtime, "docker.log");
  writeFileSync(
    docker,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$BRAINO_DOCKER_LOG"
if [ "$*" = "compose config --images" ]; then
  printf '%s\\n' qdrant/qdrant:v1.20.0 "$FAKE_APP_IMAGE" "$FAKE_CODELINKER_IMAGE" "$FAKE_PLUGIN_HOST_IMAGE" postgres:16.10-bookworm
elif [ "$*" = "compose config --format json" ]; then
  cat <<EOF
{
  "services": {
    "app": {
      "image": "$FAKE_APP_IMAGE"
    },
    "codelinker": {
      "image": "$FAKE_CODELINKER_IMAGE"
    },
    "plugin-host": {
      "image": "$FAKE_PLUGIN_HOST_IMAGE"
    }
  }
}
EOF
fi
`,
  );
  chmodSync(docker, 0o755);

  try {
    const result = spawnSync(resolve(root, "braino"), ["upgrade"], {
      cwd: runtime,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${runtime}:${process.env.PATH ?? ""}`,
        BRAINO_DOCKER_LOG: log,
        FAKE_APP_IMAGE: appImage,
        FAKE_CODELINKER_IMAGE: codeLinkerImage,
        FAKE_PLUGIN_HOST_IMAGE: pluginHostImage,
        DOCO_ENCRYPTION_KEY: "test-encryption-key-with-thirty-two-characters",
        BRAINO_POSTGRES_PASSWORD: "test-postgres-password",
        BRAINO_SETUP_TOKEN: "test-setup-token",
        BRAINO_CODELINKER_API_TOKEN: "test-codelinker-token-with-thirty-two-characters",
        BRAINO_PLUGIN_HOST_API_TOKEN: "test-plugin-host-token-with-thirty-two-characters",
      },
    });
    return { ...result, calls: readFileSync(log, "utf8") };
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

describe("the supported self-hosted stack", () => {
  it("boots one app with durable PostgreSQL and Qdrant services", () => {
    const compose = parse(readFileSync(resolve(root, "compose.yml"), "utf8"), { merge: true }) as {
      services: Record<string, Record<string, unknown>>;
      volumes: Record<string, unknown>;
    };

    expect(Object.keys(compose.services)).toEqual([
      "app",
      "scheduler",
      "codelinker",
      "plugin-host",
      "ollama",
      "ollama-model",
      "ollama-chat-model",
      "postgres",
      "qdrant",
      "caddy",
    ]);
    expect(compose.services.app?.build).toEqual(
      expect.objectContaining({ dockerfile: "Dockerfile" }),
    );
    expect(compose.services.scheduler?.image).toBe(compose.services.app?.image);
    expect(compose.services.scheduler?.build).toEqual(compose.services.app?.build);
    expect(compose.services.scheduler?.command).toEqual(["node", "runtime/scheduler.mjs"]);
    expect(compose.services.scheduler?.depends_on).toEqual({
      app: { condition: "service_healthy" },
    });
    expect(compose.services.scheduler?.healthcheck).toEqual({
      test: ["CMD", "node", "-e", "process.kill(1, 0)"],
      interval: "15s",
      timeout: "5s",
      start_period: "5s",
      retries: 4,
    });
    expect(compose.services.app?.depends_on).toEqual(
      expect.objectContaining({
        codelinker: expect.any(Object),
        "ollama-chat-model": { condition: "service_completed_successfully" },
        "ollama-model": { condition: "service_completed_successfully" },
        "plugin-host": expect.any(Object),
        postgres: expect.any(Object),
        qdrant: expect.any(Object),
      }),
    );
    expect(compose.services.app?.environment).toMatchObject({
      BRAINO_PLUGIN_MAX_EXECUTION_MS: "${BRAINO_PLUGIN_MAX_EXECUTION_MS:-60000}",
    });
    expect(compose.services.codelinker?.build).toEqual(
      expect.objectContaining({ dockerfile: "services/codelinker/Dockerfile" }),
    );
    expect(compose.services.codelinker?.read_only).toBe(true);
    expect(compose.services.codelinker?.cap_drop).toEqual(["ALL"]);
    expect(compose.services.codelinker?.ports).toBeUndefined();
    expect(compose.services["plugin-host"]?.build).toEqual(
      expect.objectContaining({ dockerfile: "services/plugin-host/Dockerfile" }),
    );
    expect(compose.services["plugin-host"]?.read_only).toBe(true);
    expect(compose.services["plugin-host"]?.cap_drop).toEqual(["ALL"]);
    expect(compose.services["plugin-host"]?.ports).toBeUndefined();
    expect(compose.services["plugin-host"]?.environment).toMatchObject({
      BRAINO_PLUGIN_LOCAL_NETWORK_HOSTS: "${BRAINO_PLUGIN_LOCAL_NETWORK_HOSTS:-ollama:11434}",
      BRAINO_PLUGIN_MAX_EXECUTION_MS: "${BRAINO_PLUGIN_MAX_EXECUTION_MS:-60000}",
      BRAINO_PLUGIN_HTTP_TIMEOUT_MS: "${BRAINO_PLUGIN_HTTP_TIMEOUT_MS:-50000}",
    });
    expect(compose.services.ollama?.profiles).toBeUndefined();
    expect(compose.services.ollama?.ports).toBeUndefined();
    expect(compose.services["ollama-model"]?.profiles).toBeUndefined();
    expect(compose.services["ollama-model"]?.depends_on).toEqual({
      ollama: { condition: "service_healthy" },
    });
    expect(compose.services["ollama-model"]?.command).toEqual([
      "pull",
      "${BRAINO_OLLAMA_EMBEDDING_MODEL:-embeddinggemma-2:270m}",
    ]);
    expect(compose.services["ollama-chat-model"]?.profiles).toBeUndefined();
    expect(compose.services["ollama-chat-model"]?.depends_on).toEqual({
      ollama: { condition: "service_healthy" },
    });
    expect(compose.services["ollama-chat-model"]?.command).toEqual([
      "pull",
      "${BRAINO_OLLAMA_CHAT_MODEL:-qwen3.5:4b}",
    ]);
    expect(compose.services.app?.ports).toEqual(["127.0.0.1:${BRAINO_HTTP_PORT:-3000}:3000"]);
    expect(compose.services.postgres?.ports).toBeUndefined();
    expect(compose.services.qdrant?.ports).toBeUndefined();
    expect(compose.services.caddy?.profiles).toEqual(["tls"]);
    expect(Object.keys(compose.volumes)).toEqual([
      "braino-postgres",
      "braino-qdrant",
      "braino-ollama",
      "braino-caddy-data",
      "braino-caddy-config",
    ]);
  });

  it("documents the required secrets and builds a non-root web image", () => {
    const env = readFileSync(resolve(root, ".env.example"), "utf8");
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
    const runtimeStage = dockerfile.split(" AS runtime")[1] ?? "";

    expect(env).toContain("DOCO_ENCRYPTION_KEY=");
    expect(env).toContain("BRAINO_POSTGRES_PASSWORD=");
    expect(env).toContain("BRAINO_SETUP_TOKEN=");
    expect(env).toContain("BRAINO_CODELINKER_API_TOKEN=");
    expect(env).toContain("BRAINO_PLUGIN_HOST_API_TOKEN=");
    expect(dockerfile).toContain("COPY packages/ui/package.json packages/ui/package.json");
    expect(dockerfile).toContain("pnpm --filter @braino/web build");
    expect(dockerfile).toContain("plugins/ollama-embedding");
    expect(dockerfile).toContain("plugins/ollama-chat");
    expect(dockerfile).toContain("plugins/openai-embedding");
    expect(dockerfile).toContain("plugins/openai-chat");
    expect(dockerfile).toContain("plugins/resend");
    expect(runtimeStage).toContain("/app/plugins/braino_ollama_embedding.wasm");
    expect(runtimeStage).toContain("/app/plugins/braino_ollama_chat.wasm");
    expect(runtimeStage).toContain("/app/plugins/braino_openai_embedding.wasm");
    expect(runtimeStage).toContain("/app/plugins/braino_openai_chat.wasm");
    expect(runtimeStage).toContain("/app/plugins/braino_slack.wasm");
    expect(runtimeStage).toContain("/app/plugins/braino_resend.wasm");
    expect(runtimeStage).toContain("ARG BRAINO_VERSION");
    expect(runtimeStage).toContain("ENV BRAINO_VERSION=$BRAINO_VERSION");
    expect(dockerfile).toContain("USER node");
    expect(dockerignore).toContain(".env*");
    expect(dockerignore).toContain("!.env.example");
    expect(dockerignore).toContain("backups");
    expect(dockerignore).toContain("*.tar.gz");
  });

  it("uses the balanced local models throughout fresh-install setup", () => {
    const chatManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/ollama-chat/manifest.json"), "utf8"),
    ) as { configurationSchema: { properties: { model: { default: string } } } };
    const embeddingManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/ollama-embedding/manifest.json"), "utf8"),
    ) as { configurationSchema: { properties: { model: { default: string } } } };

    expect(chatManifest.configurationSchema.properties.model.default).toBe("qwen3.5:4b");
    expect(embeddingManifest.configurationSchema.properties.model.default).toBe(
      "embeddinggemma-2:270m",
    );
    expect(readFileSync(resolve(root, "plugins/ollama-chat/src/lib.rs"), "utf8")).toContain(
      "think: false",
    );
    expect(readFileSync(resolve(root, "plugins/ollama-chat/src/lib.rs"), "utf8")).toContain(
      '"qwen3.5:4b"',
    );
    // Setup reads its defaults from those manifests; the web code names no model.
    for (const file of readdirSync(resolve(root, "packages/web/app"), { recursive: true })) {
      if (typeof file !== "string" || !/\.tsx?$/.test(file) || /test\.ts$/.test(file)) continue;
      const source = readFileSync(resolve(root, "packages/web/app", file), "utf8");
      expect(source, file).not.toMatch(/qwen3|embeddinggemma|gpt-4|text-embedding-3/);
    }
  });

  it("bundles OpenAI chat and embedding plugins that each require their own API key", () => {
    const chatManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/openai-chat/manifest.json"), "utf8"),
    ) as {
      capabilities: Record<string, number>;
      permissions: { network: string[] };
      secretSchema: { required: string[] };
    };
    const embeddingManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/openai-embedding/manifest.json"), "utf8"),
    ) as {
      capabilities: Record<string, number>;
      permissions: { network: string[] };
      secretSchema: { required: string[] };
    };

    expect(chatManifest.capabilities).toEqual({ "chat.complete": 1 });
    expect(embeddingManifest.capabilities).toEqual({ "embedding.embed": 1 });
    expect(chatManifest.permissions.network).toEqual(["api.openai.com"]);
    expect(embeddingManifest.permissions.network).toEqual(["api.openai.com"]);
    expect(chatManifest.secretSchema.required).toEqual(["api_key"]);
    expect(embeddingManifest.secretSchema.required).toEqual(["api_key"]);
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("plugins/openai-chat/Cargo.toml");
    expect(workflow).toContain("plugins/openai-embedding/Cargo.toml");
  });

  it("bundles hosted Braino's Anthropic chat and Voyage embedding providers as separate plugins", () => {
    const chatManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/anthropic-chat/manifest.json"), "utf8"),
    ) as {
      capabilities: Record<string, number>;
      permissions: { network: string[] };
      configurationSchema: { properties: { model: { default: string } } };
      secretSchema: { required: string[] };
    };
    const embeddingManifest = JSON.parse(
      readFileSync(resolve(root, "plugins/voyage-embedding/manifest.json"), "utf8"),
    ) as typeof chatManifest;
    const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const chatSource = readFileSync(resolve(root, "plugins/anthropic-chat/src/lib.rs"), "utf8");
    const embeddingSource = readFileSync(
      resolve(root, "plugins/voyage-embedding/src/lib.rs"),
      "utf8",
    );

    expect(chatManifest.capabilities).toEqual({ "chat.complete": 1 });
    expect(chatManifest.permissions.network).toEqual(["api.anthropic.com"]);
    expect(chatManifest.configurationSchema.properties.model.default).toBe("claude-sonnet-4-6");
    expect(chatManifest.secretSchema.required).toEqual(["api_key"]);
    expect(embeddingManifest.capabilities).toEqual({ "embedding.embed": 1 });
    expect(embeddingManifest.permissions.network).toEqual(["api.voyageai.com"]);
    expect(embeddingManifest.configurationSchema.properties.model.default).toBe("voyage-4");
    expect(embeddingManifest.secretSchema.required).toEqual(["api_key"]);
    expect(chatSource).toContain("https://api.anthropic.com/v1/messages");
    expect(chatSource).toContain('"anthropic-version"');
    expect(chatSource).toContain('"x-api-key"');
    expect(embeddingSource).toContain("https://api.voyageai.com/v1/embeddings");
    expect(embeddingSource).toContain("input_type: input.input_type.as_deref()");
    expect(dockerfile).toContain("plugins/anthropic-chat");
    expect(dockerfile).toContain("plugins/voyage-embedding");
    expect(workflow).toContain("plugins/anthropic-chat/Cargo.toml");
    expect(workflow).toContain("plugins/voyage-embedding/Cargo.toml");
  });

  it("bundles the shared-gateway Slack app plugin and builds it in CI", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "plugins/slack/manifest.json"), "utf8"),
    ) as {
      capabilities: Record<string, number>;
      permissions: { network: string[] };
      configurationSchema: { required: string[] };
      secretSchema: { required: string[] };
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(manifest.capabilities).toEqual({
      "event.receive": 1,
      "team_chat.connect": 1,
      "team_chat.send": 1,
    });
    expect(manifest.permissions.network).toEqual(["*.braino.dev"]);
    expect(manifest.configurationSchema.required).toEqual(["gateway_url", "installation_id"]);
    expect(manifest.secretSchema.required).toEqual(["gateway_secret"]);
    expect(workflow).toContain("plugins/slack/Cargo.toml");
  });

  it("bundles the Resend email plugin with only its scoped API permission", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(root, "plugins/resend/manifest.json"), "utf8"),
    ) as {
      capabilities: Record<string, number>;
      permissions: { network: string[] };
      configurationSchema: { required: string[] };
      secretSchema: { required: string[] };
    };
    const source = readFileSync(resolve(root, "plugins/resend/src/lib.rs"), "utf8");
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(manifest.capabilities).toEqual({ "email.send": 1 });
    expect(manifest.permissions.network).toEqual(["api.resend.com"]);
    expect(manifest.configurationSchema.required).toEqual(["sender"]);
    expect(manifest.secretSchema.required).toEqual(["api_key"]);
    expect(source).toContain("https://api.resend.com/emails");
    expect(source).toContain('"authorization"');
    expect(workflow).toContain("plugins/resend/Cargo.toml");
  });

  it("runs installed embedding plugins through the durable retrieval scheduler", () => {
    const scheduler = readFileSync(resolve(root, "runtime/scheduler.mjs"), "utf8");

    expect(scheduler).toContain("resolveWorkspaceEmbeddingProvider");
    expect(scheduler).toContain("syncRetrievalSourceBatch");
    expect(scheduler).toContain("syncQueuedEmbeddings");
    expect(scheduler).toContain("pluginHostConnectionFromEnv(process.env)");
    expect(scheduler).toContain("DOCO_ENCRYPTION_KEY");
  });

  it("drains workspace-scoped team-chat events through the installed providers", () => {
    const scheduler = readFileSync(resolve(root, "runtime/scheduler.mjs"), "utf8");

    expect(scheduler).toContain("processNextTeamChatEvent");
    expect(scheduler).toContain("answerWorkspaceQuestion");
    expect(scheduler).toContain("resolveWorkspaceTeamChatPlugin");
    expect(scheduler).toContain("resolveWorkspaceChatProvider");
    expect(scheduler).toContain("BRAINO_TEAM_CHAT_POLL_MS");
  });

  it("fails CI on high or critical dependency advisories", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts.audit).toBe("pnpm audit --prod --audit-level high");
    expect(workflow).toContain("pnpm run audit");
  });

  it("pins every workflow action to an immutable commit", () => {
    for (const name of ["ci.yml", "release.yml"]) {
      const workflow = readFileSync(resolve(root, ".github/workflows", name), "utf8");
      const actions = [...workflow.matchAll(/uses:\s+(\S+)/g)].map((match) => match[1]);
      expect(actions.length).toBeGreaterThan(0);
      expect(actions, name).toEqual(
        actions.map((action) => expect.stringMatching(/@[0-9a-f]{40}$/)),
      );
    }
  });

  it("keeps pinned workflow actions on an automated update path", () => {
    const dependabot = parse(readFileSync(resolve(root, ".github/dependabot.yml"), "utf8")) as {
      updates: Array<Record<string, unknown>>;
    };

    expect(dependabot.updates).toContainEqual(
      expect.objectContaining({ "package-ecosystem": "github-actions", directory: "/" }),
    );
    for (const directory of [
      "/services/codelinker",
      "/services/plugin-host",
      "/services/plugin-host/fixtures/echo-plugin",
      "/plugins/ollama-embedding",
      "/plugins/ollama-chat",
      "/plugins/openai-embedding",
      "/plugins/openai-chat",
      "/plugins/resend",
    ]) {
      expect(dependabot.updates).toContainEqual(
        expect.objectContaining({ "package-ecosystem": "cargo", directory }),
      );
    }
  });

  it("ships executable backup, restore, preflight, and upgrade commands", () => {
    const commandPath = resolve(root, "braino");
    const command = readFileSync(commandPath, "utf8");
    const readme = readFileSync(resolve(root, "README.md"), "utf8");

    expect(statSync(commandPath).mode & 0o111).not.toBe(0);
    expect(command).toContain("pg_dump");
    expect(command).toContain("pg_restore");
    expect(command).toContain("DROP DATABASE braino WITH (FORCE)");
    expect(command).toContain("CREATE DATABASE braino OWNER braino");
    expect(command).not.toContain("--clean");
    expect(command).toContain("doctor)");
    expect(command).toContain("upgrade)");
    expect(command).toContain("BRAINO_CODELINKER_API_TOKEN");
    expect(command).toContain("BRAINO_PLUGIN_HOST_API_TOKEN");
    expect(command.indexOf("compose stop app")).toBeLessThan(
      command.indexOf("node_modules/@braino/db/dist/migrate.js"),
    );
    expect(command).toContain("node_modules/@braino/db/dist/migrate.js");
    expect(command).toContain("compose stop app scheduler codelinker plugin-host qdrant");
    expect(command).toContain("compose stop app scheduler");
    expect(command).toContain("/qdrant/storage");
    expect(readme).toContain("./braino backup");
    expect(readme).toContain("./braino restore");
    expect(readme).toContain("./braino upgrade");
  });

  it("applies ordered migrations before the web server accepts traffic", () => {
    const webPackage = JSON.parse(
      readFileSync(resolve(root, "packages/web/package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(webPackage.scripts.start).toBe(
      "node node_modules/@braino/db/dist/migrate.js && node server.mjs",
    );
  });

  it("preserves the public HTTPS origin behind the bundled reverse proxy", () => {
    const serverModule = pathToFileURL(resolve(root, "packages/web/server.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import express from "express";
          import { trustSingleProxy } from ${JSON.stringify(serverModule)};

          const app = express();
          trustSingleProxy(app);
          app.post("/", (request, response) => {
            response.send(new URL(request.originalUrl, \`${"${request.protocol}"}://${"${request.hostname}"}\`).origin);
          });
          const server = app.listen(0, "127.0.0.1", async () => {
            const address = server.address();
            const response = await fetch(\`http://127.0.0.1:${"${address.port}"}/\`, {
              method: "POST",
              headers: {
                Host: "meta.braino.dev",
                "X-Forwarded-Host": "meta.braino.dev",
                "X-Forwarded-Proto": "https",
              },
            });
            console.log(await response.text());
            server.close();
          });
        `,
      ],
      { cwd: resolve(root, "packages/web"), encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("https://meta.braino.dev");
  });

  it("refuses to upgrade a local app image regardless of Compose image order", () => {
    const result = runUpgradeWithImages("braino:local");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set BRAINO_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("refuses to upgrade a local CodeLinker image", () => {
    const result = runUpgradeWithImages(
      "ghcr.io/brainoinc/braino:0.1.14",
      "braino-codelinker:local",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set BRAINO_CODELINKER_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("refuses to upgrade a local plugin host image", () => {
    const result = runUpgradeWithImages(
      "ghcr.io/brainoinc/braino:0.1.14",
      "ghcr.io/brainoinc/braino-codelinker:0.1.14",
      "braino-plugin-host:local",
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Set BRAINO_PLUGIN_HOST_IMAGE to a released");
    expect(result.stdout).not.toContain("Backup written");
    expect(result.calls).not.toContain("compose pull");
  });

  it("reports and migrates the configured released app image", () => {
    const image = "ghcr.io/brainoinc/braino:0.1.0";
    const result = runUpgradeWithImages(image);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Upgrade completed with ${image}`);
    expect(result.stdout).toContain("ghcr.io/brainoinc/braino-codelinker:0.1.14");
    expect(result.stdout).toContain("ghcr.io/brainoinc/braino-plugin-host:0.1.14");
    expect(result.calls).toContain("compose pull");
    expect(result.calls).toContain("node_modules/@braino/db/dist/migrate.js");
  });

  // Alexander, 2026-11-11: agents can't push tags, so a version bump merged to
  // main releases itself; nobody pushes a v* tag by hand.
  it("releases each version bump merged to main, once", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toMatch(/on:\n {2}push:\n {4}branches: \[main\]\n/);
    expect(workflow).not.toMatch(/tags: \[/);
    expect(workflow).toContain('TAG="v$(jq -r .version package.json)"');
    expect(workflow).toContain('git ls-remote --exit-code --tags origin "refs/tags/$TAG"');
    expect(workflow).toContain("if: needs.version.outputs.unreleased == 'true'");
    expect(workflow).toContain(
      'gh release create "$TAG" release-packages/*.tgz --target "$GITHUB_SHA"',
    );
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("publishes signed AMD64 and ARM64 images tagged with the release's version", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain(
      "type=semver,pattern={{version}},value=${{ needs.version.outputs.tag }}",
    );
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("BRAINO_VERSION=${{ needs.version.outputs.tag }}");
    expect(workflow).toContain("provenance: mode=max");
    expect(workflow).toContain("sbom: true");
    expect(workflow).toContain("cosign sign --yes");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/braino-codelinker");
    expect(workflow).toContain("ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/braino-plugin-host");
    expect(workflow).toContain("services/codelinker/Dockerfile");
    expect(workflow).toContain("services/plugin-host/Dockerfile");
    expect(workflow.match(/cosign sign --yes/g)).toHaveLength(3);
  });

  it("tests the separately versioned Rust services in the required CI gate", () => {
    const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
    const releaseVersion = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };

    for (const [service, name] of [
      ["codelinker", "braino-codelinker"],
      ["plugin-host", "braino-plugin-host"],
    ]) {
      const manifest = readFileSync(resolve(root, `services/${service}/Cargo.toml`), "utf8");
      expect(manifest).toContain(`name = "${name}"`);
      expect(manifest).toContain(`version = "${releaseVersion.version}"`);
      expect(workflow).toContain(
        `cargo fmt --check --manifest-path services/${service}/Cargo.toml`,
      );
      expect(workflow).toContain(
        `cargo test --locked --manifest-path services/${service}/Cargo.toml`,
      );
      expect(workflow).toContain(
        `cargo clippy --locked --manifest-path services/${service}/Cargo.toml`,
      );
    }
    expect(workflow).toContain("rustup target add wasm32-wasip2");
    expect(workflow).toContain("services/plugin-host/fixtures/echo-plugin/Cargo.toml");
    expect(workflow).toContain("plugins/ollama-embedding/Cargo.toml");
    expect(workflow).toContain("plugins/ollama-chat/Cargo.toml");
  });

  it("publishes every versioned core package beside each release image", () => {
    const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");

    for (const name of ["shared", "plugin-runtime", "db", "index", "host", "connector-plugins"]) {
      const packageJson = JSON.parse(
        readFileSync(resolve(root, `packages/${name}/package.json`), "utf8"),
      ) as { name: string; private?: boolean; version: string };

      expect(packageJson.private, packageJson.name).not.toBe(true);
      expect(packageJson.version, packageJson.name).toBe(rootPackage.version);
      expect(workflow).toContain(`pnpm --filter ${packageJson.name} pack`);
    }
    expect(workflow).toContain("node scripts/verify-release-packages.mjs release-packages");
    expect(workflow).toContain('gh release create "$TAG" release-packages/*.tgz');
    expect(workflow).not.toContain("--clobber");
  });

  it("gates releases on the executable v0.1 conformance contract", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = readFileSync(resolve(root, "scripts/conformance.sh"), "utf8");
    const conformanceCompose = parse(
      readFileSync(resolve(root, "compose.conformance.yml"), "utf8"),
    ) as {
      services: Record<string, { profiles?: string[] }> & {
        ollama: {
          image: string;
          profiles: string[];
          entrypoint: string[];
          healthcheck: { test: string[] };
        };
        "ollama-model": { image: string; profiles: string[]; command: string[] };
        "ollama-chat-model": { image: string; profiles: string[]; command: string[] };
      };
    };
    const workflow = readFileSync(resolve(root, ".github/workflows/release.yml"), "utf8");
    const contract = readFileSync(resolve(root, "docs/v0.1-conformance.md"), "utf8");

    expect(packageJson.scripts.conformance).toBe("bash scripts/conformance.sh");
    for (const proof of [
      "single-workspace.real-db.test.ts",
      "workspace-admin.real-db.test.ts",
      "times.real-db.test.ts",
      "collaborators.real-db.test.ts",
      "changesets.real-db.test.ts",
      "workspace-search.real-db.test.ts",
      "mcp-core.real-db.test.ts",
      "incoming-webhooks.real-db.test.ts",
      "github-connections.real-db.test.ts",
      "schema-apply-once.test.ts",
      "self-hosted-compose.test.ts",
      "design-language.test.ts",
      "admin-console.test.ts",
    ]) {
      expect(script).toContain(proof);
      expect(contract).toContain(proof);
    }
    expect(script).toContain("docker compose");
    expect(script).toContain("COMPOSE_FILE=compose.yml:compose.conformance.yml");
    const modelFixture = conformanceCompose.services.ollama;
    expect(modelFixture.image).toBe("${BRAINO_IMAGE}");
    expect(modelFixture.profiles).toEqual(["conformance"]);
    expect(modelFixture.entrypoint).toEqual(["node", "--input-type=module"]);
    expect(modelFixture.healthcheck.test.join(" ")).toContain("/api/tags");
    for (const bootstrap of ["ollama-model", "ollama-chat-model"] as const) {
      expect(conformanceCompose.services[bootstrap].image).toBe("${BRAINO_IMAGE}");
      expect(conformanceCompose.services[bootstrap].profiles).toEqual(["conformance"]);
      expect(conformanceCompose.services[bootstrap].command).toEqual(["-e", "process.exit(0)"]);
    }
    expect(script).toContain("http://codelinker:8080/healthz");
    expect(script).toContain("http://plugin-host:8080/healthz");
    expect(script).toContain("braino_records");
    expect(script).toContain("/collections/braino_records");
    expect(script).toContain('"$origin/admin"');
    expect(script).toContain('"$origin/plugins"');
    expect(script).toContain('"$origin/integrations"');
    expect(script).toContain('"$origin/mcp-tokens"');
    expect(script).toContain("grep -q 'Installed' \"$runtime/management-plugins.html\"");
    expect(script).toContain("grep -q 'Sources' \"$runtime/management-sources.html\"");
    expect(script).toContain(
      "grep -q 'Connect an agent' \"$runtime/management-agent-access.html\"",
    );
    expect(script).not.toContain("grep -q 'Connect Señor Braino'");
    expect(script).toContain('"$origin/times"');
    expect(script).toContain("./braino backup");
    expect(script).toContain("./braino restore");
    expect(script).toContain("600");
    expect(workflow.indexOf("pnpm conformance")).toBeGreaterThan(0);
    expect(workflow.indexOf("pnpm conformance")).toBeLessThan(
      workflow.indexOf("docker/build-push-action"),
    );
  });
});
