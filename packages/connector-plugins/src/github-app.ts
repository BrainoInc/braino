import { createHmac, createSign, timingSafeEqual } from "node:crypto";
import {
  type BrainoPlugin,
  PLUGIN_PROTOCOL_VERSION,
  type PluginEvent,
  definePlugin,
} from "@doco/plugin-runtime";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_PAGES = 100;

type Fetcher = typeof fetch;

export class GithubAppPluginError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 502,
  ) {
    super(message);
    this.name = "GithubAppPluginError";
  }
}

export interface GithubAppCredentials {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  clientId?: string;
  clientSecret?: string;
  slug?: string;
  htmlUrl?: string;
}

export interface GithubAppRegistration extends GithubAppCredentials {
  slug: string;
  htmlUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface GithubInstallation {
  id: number;
  account: string;
  organization: boolean;
  repositorySelection: "all" | "selected";
}

export interface GithubRepository {
  fullName: string;
  defaultBranch: string;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function normalizeGithubPrivateKey(value: string): string {
  let key = value.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  if (key.includes("\\n")) key = key.replaceAll("\\n", "\n");
  key = key.replaceAll(/\r\n?/g, "\n");
  if (!key.includes("\n")) {
    const match = /-----BEGIN ([A-Z0-9 ]+?)-----(.+?)-----END \1-----/.exec(key);
    if (match?.[1] && match[2]) {
      const body = match[2].replaceAll(/\s/g, "");
      key = `-----BEGIN ${match[1].trim()}-----\n${body.match(/.{1,64}/g)?.join("\n") ?? body}\n-----END ${match[1].trim()}-----`;
    }
  }
  return key;
}

export function buildGithubAppJwt(input: {
  appId: number;
  privateKey: string;
  nowSeconds?: number;
}): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: input.appId }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(normalizeGithubPrivateKey(input.privateKey));
  return `${signingInput}.${base64url(signature)}`;
}

function headers(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "User-Agent": "braino-github-app",
    "X-GitHub-Api-Version": API_VERSION,
  };
}

async function githubRequest(
  fetcher: Fetcher,
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetcher(`${GITHUB_API}${path}`, {
    method,
    headers: headers(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new GithubAppPluginError(
      `GitHub ${method} ${path} failed (${response.status}).`,
      "github_request_failed",
      response.status,
    );
  }
  return response.status === 204 ? null : response.json();
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new GithubAppPluginError(`GitHub returned no ${name}.`, "github_response_invalid");
  }
  return value;
}

function requiredPositiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new GithubAppPluginError(`GitHub returned no ${name}.`, "github_response_invalid");
  }
  return Number(value);
}

function normalizedOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GithubAppPluginError("The public Braino URL is invalid.", "public_url_invalid", 400);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new GithubAppPluginError(
      "The public Braino URL must use HTTPS.",
      "public_url_invalid",
      400,
    );
  }
  return new URL(url.origin);
}

export function githubAppSetup(input: { fetcher?: Fetcher } = {}) {
  const fetcher = input.fetcher ?? fetch;
  return Object.freeze({
    manifest(publicUrl: string) {
      const origin = normalizedOrigin(publicUrl);
      const endpoint = (path: string) => new URL(path, origin).toString();
      return {
        name: `Braino ${origin.hostname}`.slice(0, 34),
        url: origin.toString().replace(/\/$/, ""),
        hook_attributes: {
          url: endpoint("/api/v1/github/app/webhooks"),
          active: true,
        },
        redirect_url: endpoint("/integrations/github/app/callback"),
        callback_urls: [endpoint("/integrations/github/app/callback")],
        setup_url: endpoint("/integrations/github/install"),
        public: false,
        request_oauth_on_install: false,
        default_permissions: {
          administration: "write",
          checks: "write",
          contents: "read",
          issues: "read",
          metadata: "read",
          pull_requests: "read",
        },
        default_events: ["issues", "pull_request", "push"],
      } as const;
    },
    async exchangeManifestCode(code: string): Promise<GithubAppRegistration> {
      const clean = code.trim();
      if (!clean)
        throw new GithubAppPluginError("GitHub App code is required.", "code_required", 400);
      const response = await fetcher(
        `${GITHUB_API}/app-manifests/${encodeURIComponent(clean)}/conversions`,
        {
          method: "POST",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!response.ok) {
        throw new GithubAppPluginError(
          `GitHub App creation failed (${response.status}).`,
          "manifest_exchange_failed",
          response.status,
        );
      }
      const value = (await response.json()) as Record<string, unknown>;
      return {
        appId: requiredPositiveInteger(value.id, "App id"),
        slug: requiredString(value.slug, "App slug"),
        htmlUrl: requiredString(value.html_url, "App URL"),
        clientId: requiredString(value.client_id, "client id"),
        clientSecret: requiredString(value.client_secret, "client secret"),
        privateKey: requiredString(value.pem, "private key"),
        webhookSecret: requiredString(value.webhook_secret, "webhook secret"),
      };
    },
  });
}

export interface GithubAppConnectorPlugin extends BrainoPlugin {
  readonly github: {
    mintInstallationToken(installationId: string | number): Promise<string>;
    installation(installationId: string | number): Promise<GithubInstallation>;
    repositories(installationId: string | number): Promise<readonly GithubRepository[]>;
    pullRequestCommits(input: {
      installationId: string | number;
      repository: string;
      pullNumber: number;
    }): Promise<readonly string[]>;
  };
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1]?.trim() ?? "";
}

function verifySignature(body: Uint8Array, signature: string, secret: string): void {
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new GithubAppPluginError(
      "GitHub webhook signature is invalid.",
      "signature_invalid",
      401,
    );
  }
}

function repositoryParts(repository: string): [string, string] {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new GithubAppPluginError("GitHub repository is invalid.", "repository_invalid", 400);
  }
  return [owner, name];
}

function nextLink(value: string | null): string | null {
  return (
    value
      ?.split(",")
      .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1] ?? null)
      .find((part) => part !== null) ?? null
  );
}

function brainoRuleset(checkName: string, appId: number) {
  return {
    name: checkName,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          required_status_checks: [{ context: checkName, integration_id: appId }],
          strict_required_status_checks_policy: false,
        },
      },
    ],
  } as const;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function isBrainoRuleset(value: unknown, checkName: string, appId: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const rule = value as Record<string, unknown>;
  const conditions = rule.conditions as
    | { ref_name?: { include?: unknown; exclude?: unknown } }
    | undefined;
  const rules = rule.rules;
  if (!Array.isArray(rules) || rules.length !== 1) return false;
  const statusRule = rules[0] as
    | {
        type?: unknown;
        parameters?: {
          required_status_checks?: unknown;
          strict_required_status_checks_policy?: unknown;
        };
      }
    | undefined;
  const checks = statusRule?.parameters?.required_status_checks;
  if (!Array.isArray(checks) || checks.length !== 1) return false;
  const check = checks[0] as { context?: unknown; integration_id?: unknown } | undefined;
  return (
    rule.name === checkName &&
    rule.target === "branch" &&
    rule.enforcement === "active" &&
    sameStrings(conditions?.ref_name?.include, ["~DEFAULT_BRANCH"]) &&
    sameStrings(conditions?.ref_name?.exclude, []) &&
    statusRule?.type === "required_status_checks" &&
    statusRule.parameters?.strict_required_status_checks_policy === false &&
    check?.context === checkName &&
    Number(check.integration_id) === appId
  );
}

export function createGithubAppPlugin(input: {
  credentials: GithubAppCredentials;
  fetcher?: Fetcher;
  jwt?: () => string;
}): GithubAppConnectorPlugin {
  const fetcher = input.fetcher ?? fetch;
  const appJwt = () =>
    input.jwt?.() ??
    buildGithubAppJwt({ appId: input.credentials.appId, privateKey: input.credentials.privateKey });
  const mintInstallationToken = async (installationId: string | number): Promise<string> => {
    const value = (await githubRequest(
      fetcher,
      appJwt(),
      "POST",
      `/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
    )) as Record<string, unknown>;
    return requiredString(value.token, "installation token");
  };
  const plugin = definePlugin({
    manifest: {
      protocolVersion: PLUGIN_PROTOCOL_VERSION,
      id: "braino.github",
      name: "GitHub",
      version: "1.0.0",
      capabilities: {
        "event.receive": 1,
        "scm.check.publish": 1,
        "scm.ruleset.reconcile": 1,
      },
      permissions: { network: ["api.github.com"] },
      configurationSchema: {
        type: "object",
        properties: {
          app_id: { type: "string" },
          slug: { type: "string" },
        },
        additionalProperties: false,
      },
      secretSchema: {
        type: "object",
        properties: {
          private_key: { type: "string" },
          webhook_secret: { type: "string" },
          client_secret: { type: "string" },
        },
        required: ["private_key", "webhook_secret"],
        additionalProperties: false,
      },
    },
    capabilities: {
      "event.receive": {
        async receive(request): Promise<readonly PluginEvent[]> {
          const deliveryId = headerValue(request.headers, "x-github-delivery");
          const kind = headerValue(request.headers, "x-github-event");
          const signature = headerValue(request.headers, "x-hub-signature-256");
          if (!deliveryId || !kind || !signature) {
            throw new GithubAppPluginError(
              "GitHub delivery headers are required.",
              "headers_required",
              400,
            );
          }
          verifySignature(request.body, signature, input.credentials.webhookSecret);
          let data: unknown;
          try {
            data = JSON.parse(new TextDecoder().decode(request.body));
          } catch {
            throw new GithubAppPluginError(
              "GitHub webhook payload is invalid.",
              "payload_invalid",
              400,
            );
          }
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new GithubAppPluginError(
              "GitHub webhook payload is invalid.",
              "payload_invalid",
              400,
            );
          }
          return [
            {
              id: deliveryId,
              occurredAt: new Date().toISOString(),
              kind,
              data: data as Record<string, unknown>,
            },
          ];
        },
      },
      "scm.check.publish": {
        async publish(check) {
          const [owner, repository] = repositoryParts(check.repository);
          const token = await mintInstallationToken(check.installationId);
          await githubRequest(fetcher, token, "POST", `/repos/${owner}/${repository}/check-runs`, {
            name: check.name,
            head_sha: check.headSha,
            status: "completed",
            conclusion: check.conclusion,
            output: { title: check.title, summary: check.summary },
            ...(check.detailsUrl ? { details_url: check.detailsUrl } : {}),
          });
        },
      },
      "scm.ruleset.reconcile": {
        async reconcile(rule) {
          const [owner, repository] = repositoryParts(rule.repository);
          const token = await mintInstallationToken(rule.installationId);
          const path = `/repos/${owner}/${repository}/rulesets`;
          const listed = (await githubRequest(
            fetcher,
            token,
            "GET",
            `${path}?includes_parents=false&per_page=100`,
          )) as unknown;
          if (!Array.isArray(listed)) {
            throw new GithubAppPluginError(
              "GitHub returned invalid repository rulesets.",
              "github_response_invalid",
            );
          }
          const existing = listed.find(
            (item): item is { id: number; name: string } =>
              Boolean(item) &&
              typeof item === "object" &&
              (item as { name?: unknown }).name === rule.checkName &&
              Number.isInteger((item as { id?: unknown }).id),
          );
          if (!rule.required && !existing) return "unchanged";
          if (existing) {
            if (rule.required) {
              const current = await githubRequest(fetcher, token, "GET", `${path}/${existing.id}`);
              if (isBrainoRuleset(current, rule.checkName, input.credentials.appId)) {
                return "unchanged";
              }
              await githubRequest(
                fetcher,
                token,
                "PATCH",
                `${path}/${existing.id}`,
                brainoRuleset(rule.checkName, input.credentials.appId),
              );
              return "updated";
            }
            await githubRequest(fetcher, token, "DELETE", `${path}/${existing.id}`);
            return "removed";
          }
          await githubRequest(
            fetcher,
            token,
            "POST",
            path,
            brainoRuleset(rule.checkName, input.credentials.appId),
          );
          return "created";
        },
      },
    },
  });

  return Object.freeze({
    ...plugin,
    github: Object.freeze({
      mintInstallationToken,
      async installation(installationId: string | number): Promise<GithubInstallation> {
        const value = (await githubRequest(
          fetcher,
          appJwt(),
          "GET",
          `/app/installations/${encodeURIComponent(String(installationId))}`,
        )) as Record<string, unknown>;
        const account = value.account as Record<string, unknown> | undefined;
        const selection = value.repository_selection;
        return {
          id: requiredPositiveInteger(value.id ?? Number(installationId), "installation id"),
          account: requiredString(account?.login, "installation account"),
          organization: account?.type === "Organization",
          repositorySelection: selection === "all" ? "all" : "selected",
        };
      },
      async repositories(installationId: string | number): Promise<readonly GithubRepository[]> {
        const token = await mintInstallationToken(installationId);
        const repositories: GithubRepository[] = [];
        let next: string | null = `${GITHUB_API}/installation/repositories?per_page=100`;
        for (let page = 0; next && page < MAX_PAGES; page += 1) {
          const response = await fetcher(next, {
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new GithubAppPluginError(
              `GitHub repository list failed (${response.status}).`,
              "github_request_failed",
              response.status,
            );
          }
          const value = (await response.json()) as { repositories?: unknown };
          if (!Array.isArray(value.repositories)) {
            throw new GithubAppPluginError(
              "GitHub returned an invalid repository list.",
              "github_response_invalid",
            );
          }
          for (const item of value.repositories) {
            const repository = item as Record<string, unknown>;
            repositories.push({
              fullName: requiredString(repository.full_name, "repository name"),
              defaultBranch: requiredString(repository.default_branch, "default branch"),
            });
          }
          next = nextLink(response.headers.get("link"));
        }
        if (next) {
          throw new GithubAppPluginError(
            "GitHub repository pagination exceeded 100 pages.",
            "github_too_large",
            422,
          );
        }
        return repositories;
      },
      async pullRequestCommits({
        installationId,
        repository,
        pullNumber,
      }: {
        installationId: string | number;
        repository: string;
        pullNumber: number;
      }) {
        const [owner, name] = repositoryParts(repository);
        const token = await mintInstallationToken(installationId);
        const messages: string[] = [];
        let next: string | null =
          `${GITHUB_API}/repos/${owner}/${name}/pulls/${pullNumber}/commits?per_page=100`;
        for (let page = 0; next && page < MAX_PAGES; page += 1) {
          const response = await fetcher(next, {
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new GithubAppPluginError(
              `GitHub pull-request commits failed (${response.status}).`,
              "github_request_failed",
              response.status,
            );
          }
          const value = (await response.json()) as unknown;
          if (!Array.isArray(value)) {
            throw new GithubAppPluginError(
              "GitHub returned invalid pull-request commits.",
              "github_response_invalid",
            );
          }
          for (const item of value) {
            const commit = (item as { commit?: { message?: unknown } }).commit;
            messages.push(requiredString(commit?.message, "commit message"));
          }
          next = nextLink(response.headers.get("link"));
        }
        if (next) {
          throw new GithubAppPluginError(
            "GitHub pull-request commit pagination exceeded 100 pages.",
            "github_too_large",
            422,
          );
        }
        return messages;
      },
    }),
  });
}
