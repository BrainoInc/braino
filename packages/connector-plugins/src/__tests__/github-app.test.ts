import { createHmac } from "node:crypto";
import { pluginCapability } from "@doco/plugin-runtime";
import { describe, expect, it } from "vitest";
import { createGithubAppPlugin, githubAppSetup } from "../github-app.js";

const privateKey = `-----BEGIN RSA PRIVATE KEY-----
MIIBOgIBAAJBAK6YhR1Wj8pCZWO9QePZEB1Y0bY5Fq4I9eKfCjQh2KBUFPgRjclR
9mM1qKc4oWZQlKiwLw4HlH6K8uMZrj8g0wMCAwEAAQJAGUySrn8yUUpmQw8jH5eB
4hyD+QvMyJv1L0FEy8Q3pFQlYtE0I2I4PLvA0eQwj1fDN9Q2uO5ZjCj1GPI2gQKBg
QDclTk0v4lXrm5qA2mMvfQH5x5fC9mD4FmrE5kQOGPjRr0j0zQk9H2d5UjP0HFx
7wIhAPQCF8tnn4LQdE4fF5G0X9pT0yW3f7H3J9QeLP0CIQDDBmYRj0y5dQm7YF4u
v2HjN0kQx7KpY3g7jR0l1P4l+wIhAJd6lD0w5l2bV4z5aR9l6P1qQqgk2XxO3Gv
YF7tB5qBAiEAuYzQjz0P4OaFJz7mYl6dP2rZkP4qH8tT1uP5Y3L2p7sCIQCV9J3
9P4j7zF9Q5t2X8mZ0J4Y6rL3pQ8dT1xG7P5mQ==
-----END RSA PRIVATE KEY-----`;

describe("GitHub App connector plugin", () => {
  it("creates an operator-owned App manifest and exchanges the one-time code", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const setup = githubAppSetup({
      fetcher: (async (input, init) => {
        const url = new URL(typeof input === "string" ? input : input.toString());
        requests.push({ path: url.pathname, method: init?.method ?? "GET" });
        return Response.json({
          id: 99,
          slug: "acme-braino",
          html_url: "https://github.com/apps/acme-braino",
          client_id: "Iv1.client",
          client_secret: "client-secret",
          pem: privateKey,
          webhook_secret: "webhook-secret",
        });
      }) as typeof fetch,
    });

    expect(setup.manifest("https://braino.example")).toMatchObject({
      name: "Braino braino.example",
      url: "https://braino.example",
      hook_attributes: {
        url: "https://braino.example/api/v1/github/app/webhooks",
        active: true,
      },
      redirect_url: "https://braino.example/integrations/github/app/callback",
      setup_url: "https://braino.example/integrations/github/install",
      public: false,
      default_permissions: {
        administration: "write",
        checks: "write",
        contents: "read",
        issues: "read",
        metadata: "read",
        pull_requests: "read",
      },
      default_events: ["issues", "pull_request", "push"],
    });
    await expect(setup.exchangeManifestCode("manifest-code")).resolves.toMatchObject({
      appId: 99,
      slug: "acme-braino",
      privateKey,
      webhookSecret: "webhook-secret",
    });
    expect(requests).toEqual([
      { path: "/app-manifests/manifest-code/conversions", method: "POST" },
    ]);
  });

  it("verifies webhooks and publishes the Braino check with an installation token", async () => {
    const calls: Array<{ path: string; body?: unknown }> = [];
    const fetcher = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      calls.push({
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (url.pathname === "/app/installations/7/access_tokens") {
        return Response.json({ token: "installation-token", expires_at: "2026-11-16T17:00:00Z" });
      }
      if (url.pathname === "/repos/acme/widgets/check-runs") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer installation-token");
        return Response.json({ id: 1 }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const plugin = createGithubAppPlugin({
      credentials: { appId: 99, privateKey, webhookSecret: "webhook-secret" },
      fetcher,
      jwt: () => "app-jwt",
    });
    const body = JSON.stringify({
      action: "opened",
      installation: { id: 7 },
      repository: { full_name: "acme/widgets" },
    });
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;

    await expect(
      pluginCapability(plugin, "event.receive").receive({
        body: new TextEncoder().encode(body),
        headers: {
          "x-github-delivery": "delivery-1",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signature,
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "delivery-1",
        kind: "pull_request",
        data: expect.objectContaining({ repository: { full_name: "acme/widgets" } }),
      }),
    ]);

    await pluginCapability(plugin, "scm.check.publish").publish({
      installationId: "7",
      repository: "acme/widgets",
      name: "Braino",
      headSha: "abc123",
      conclusion: "failure",
      title: "Didn't go through Braino",
      summary: "No Braino brief was found.",
    });
    expect(calls.at(-1)).toEqual({
      path: "/repos/acme/widgets/check-runs",
      body: {
        name: "Braino",
        head_sha: "abc123",
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Didn't go through Braino",
          summary: "No Braino brief was found.",
        },
      },
    });
  });

  it("reconciles exactly one non-strict required-check ruleset", async () => {
    const posts: unknown[] = [];
    let rulesets: Array<{ id: number; name: string }> = [];
    let configured: Record<string, unknown> | null = null;
    const fetcher = (async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/app/installations/7/access_tokens") {
        return Response.json({ token: "installation-token", expires_at: "later" });
      }
      if (
        url.pathname === "/repos/acme/widgets/rulesets" &&
        (!init?.method || init.method === "GET")
      ) {
        return Response.json(rulesets);
      }
      if (url.pathname === "/repos/acme/widgets/rulesets" && init?.method === "POST") {
        configured = JSON.parse(String(init.body));
        posts.push(configured);
        rulesets = [{ id: 42, name: "Braino" }];
        return Response.json({ id: 42 }, { status: 201 });
      }
      if (url.pathname === "/repos/acme/widgets/rulesets/42" && init?.method === "GET") {
        return Response.json({ id: 42, ...configured });
      }
      if (url.pathname === "/repos/acme/widgets/rulesets/42" && init?.method === "PATCH") {
        configured = JSON.parse(String(init.body));
        posts.push(configured);
        return Response.json({ id: 42 }, { status: 200 });
      }
      if (url.pathname === "/repos/acme/widgets/rulesets/42" && init?.method === "DELETE") {
        rulesets = [];
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const plugin = createGithubAppPlugin({
      credentials: { appId: 99, privateKey, webhookSecret: "webhook-secret" },
      fetcher,
      jwt: () => "app-jwt",
    });
    const capability = pluginCapability(plugin, "scm.ruleset.reconcile");
    const input = {
      installationId: "7",
      repository: "acme/widgets",
      checkName: "Braino",
      required: true,
    };

    await expect(capability.reconcile(input)).resolves.toBe("created");
    await expect(capability.reconcile(input)).resolves.toBe("unchanged");
    configured = { ...configured, enforcement: "evaluate" };
    await expect(capability.reconcile(input)).resolves.toBe("updated");
    await expect(capability.reconcile({ ...input, required: false })).resolves.toBe("removed");
    expect(posts).toEqual([
      {
        name: "Braino",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "Braino", integration_id: 99 }],
              strict_required_status_checks_policy: false,
            },
          },
        ],
      },
      {
        name: "Braino",
        target: "branch",
        enforcement: "active",
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          {
            type: "required_status_checks",
            parameters: {
              required_status_checks: [{ context: "Braino", integration_id: 99 }],
              strict_required_status_checks_policy: false,
            },
          },
        ],
      },
    ]);
  });

  it("reads every pull-request commit page before deciding whether Braino was used", async () => {
    const fetcher = (async (input) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/app/installations/7/access_tokens") {
        return Response.json({ token: "installation-token", expires_at: "later" });
      }
      if (url.pathname === "/repos/acme/widgets/pulls/12/commits") {
        if (url.searchParams.get("page") === "2") {
          return Response.json([{ commit: { message: "Doco-Brief: https://doco.to/brief/2" } }]);
        }
        return Response.json([{ commit: { message: "First page" } }], {
          headers: {
            Link: '<https://api.github.com/repos/acme/widgets/pulls/12/commits?per_page=100&page=2>; rel="next"',
          },
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    const plugin = createGithubAppPlugin({
      credentials: { appId: 99, privateKey, webhookSecret: "webhook-secret" },
      fetcher,
      jwt: () => "app-jwt",
    });

    await expect(
      plugin.github.pullRequestCommits({
        installationId: 7,
        repository: "acme/widgets",
        pullNumber: 12,
      }),
    ).resolves.toEqual(["First page", "Doco-Brief: https://doco.to/brief/2"]);
  });
});
