import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const app = resolve(import.meta.dirname);
const admin = readFileSync(resolve(app, "routes/admin.tsx"), "utf8");
const routes = readFileSync(resolve(app, "routes.ts"), "utf8");
const root = readFileSync(resolve(app, "root.tsx"), "utf8");
const agentSidebar = readFileSync(resolve(app, "components/agent-sidebar.tsx"), "utf8");
const siteHeader = readFileSync(resolve(app, "components/site-header.tsx"), "utf8");
const senorBraino = readFileSync(resolve(app, "routes/api.v1.senor-braino[.]json.ts"), "utf8");
const collaborators = readFileSync(resolve(app, "routes/collaborators.tsx"), "utf8");
const integrations = readFileSync(resolve(app, "routes/integrations.tsx"), "utf8");
const mcpTokens = readFileSync(resolve(app, "routes/mcp-tokens.tsx"), "utf8");
const plugins = readFileSync(resolve(app, "routes/plugins.tsx"), "utf8");
const workspace = readFileSync(resolve(app, "routes/_index.tsx"), "utf8");
const timesIndex = readFileSync(resolve(app, "routes/times._index.tsx"), "utf8");

describe("open Braino administration", () => {
  it("has one owner console for the single workspace", () => {
    expect(routes).toContain('route("admin", "routes/admin.tsx")');
    expect(routes).toContain('route("times", "routes/times._index.tsx")');
    expect(routes).toContain(
      'route("api/v1/senor-braino.json", "routes/api.v1.senor-braino[.]json.ts")',
    );
    expect(routes).toContain('route("times/:day", "routes/times.$day.tsx")');
    expect(admin).toContain("Workspace administration");
    expect(admin).toContain('id="metrics-title"');
    expect(admin).toMatch(/<h2[^>]+id="metrics-title"[^>]*>\s*\{t\("Metrics"\)\}\s*<\/h2>/);
    expect(admin).toContain("Current totals for this workspace.");
    expect(admin).toContain("Workspace settings");
    expect(admin).toContain("Braino Times");
    expect(admin).toContain('name="times_timezone"');
    expect(admin).toContain('name="times_public"');
    expect(admin).toContain('to="/times"');
    expect(admin).toContain("People and access");
    expect(admin).toContain("Sources");
    expect(admin).toContain("Plugins");
    expect(admin).toContain("Agent access");
    expect(root).toContain("<AgentSidebar />");
    expect(root).toContain("doco-shell-body");
    expect(root).not.toContain('to="/senor-braino"');
    expect(agentSidebar).toContain("senor-doco-rail");
    expect(agentSidebar).toContain('const RAIL_COLLAPSED = "32px"');
    expect(agentSidebar).toContain('const RAIL_DEFAULT = "320px"');
    expect(agentSidebar).toContain("/api/v1/senor-braino.json");
    expect(senorBraino).toContain("sendWorkspaceChatMessage");
    expect(senorBraino).toContain("listWorkspaceChatMessages");
    expect(mcpTokens).toContain("Connect an agent");
    expect(mcpTokens).toContain("OAuth");
    expect(mcpTokens).toContain("This instance connects directly");
    expect(mcpTokens).not.toContain("Open ChatGPT Plugins");
    expect(admin).toContain("Deployment");
    expect(admin).toContain("Operations");
    expect(admin).toContain("CodeLinker");
    expect(admin).toContain("BRAINO_CODELINKER_URL");
    expect(admin).toContain("BRAINO_CODELINKER_API_TOKEN");
    expect(admin).toContain('to="/collaborators"');
    expect(admin).toContain('to="/integrations"');
    expect(admin).toContain('to="/plugins"');
    expect(admin).toContain('to="/mcp-tokens"');
  });

  it("gives plugins, sources, and agent access one management home each", () => {
    expect(routes).toContain('route("plugins", "routes/plugins.tsx")');
    expect(plugins).toContain("Model plugins");
    expect(plugins).toContain("Email provider");
    expect(plugins).toContain("Señor Braino for Slack");
    expect(plugins).toContain('to="/admin/models"');
    expect(plugins).toContain('to: "/integrations/email"');
    expect(plugins).toContain('to: "/integrations/slack-app"');

    expect(integrations).toContain('title={t("Sources")}');
    expect(integrations).toContain("Slack channel import");
    expect(integrations).toContain("Notion");
    expect(integrations).toContain("Google Drive");
    expect(integrations).toContain("Braino for GitHub");
    expect(integrations).not.toContain('to="/integrations/email"');
    expect(integrations).not.toContain('to="/integrations/slack-app"');

    expect(workspace.match(/to="\/integrations"/g)).toHaveLength(1);
    expect(workspace).toContain('to="/plugins"');
    expect(workspace).toContain('{t("Agent access")}');
  });

  it("changes models through the setup screens, with no model form of its own", () => {
    expect(routes).toContain('route("admin/models", "routes/admin.models._index.tsx")');
    expect(routes).toContain('route("admin/models/:model", "routes/admin.models.$model.tsx")');
    expect(routes).toContain('route("integrations/email", "routes/integrations.email.tsx")');
    expect(routes).toContain(
      'route("admin/models/:model/:pluginId", "routes/admin.models.$model.$pluginId.tsx")',
    );
    expect(admin).toContain('id="model-plugins"');
    expect(admin).toContain("Required model plugins");
    expect(admin).toContain('to="/admin/models"');
    expect(admin).toContain("loadModelSetup");
    expect(admin).not.toMatch(/name="(chat_model|embedding_model|embedding_dimensions|api_key)"/);
    expect(admin).not.toMatch(/install_ollama|configure_ollama|configure_openai_provider/);
    expect(admin).not.toMatch(
      /installPlugin|configurePluginInstallation|assignWorkspaceModelPlugin/,
    );
  });

  it("shows rolling operational metrics with the required comparison context", () => {
    expect(admin).toContain("METRIC_PERIODS");
    expect(admin).toContain('{ value: "24h", label: msg("24 hours")');
    expect(admin).toContain('{ value: "7d", label: msg("7 days")');
    expect(admin).toContain('{ value: "30d", label: msg("30 days")');
    expect(admin).toContain('aria-label={t("Metrics time period")}');
    expect(admin).toContain("to={`?period=${option.value}`}");
    expect(admin).toContain(
      'aria-current={option.value === overview.activity.period ? "true" : undefined}',
    );
    expect(admin).toContain("vs previous {period");
    expect(admin).toContain("by agents");
  });

  it("keeps the hosted control plane out of the public console", () => {
    expect(admin).not.toMatch(/billing|waitlist|top workspaces|superadmin/i);
  });

  it("does not reveal a private Times edition through the latest-edition redirect", () => {
    expect(timesIndex).toContain("loadTimesEdition");
    expect(timesIndex).toContain('edition.kind === "hidden"');
  });

  it("shows Admin in the global header only to workspace owners", () => {
    expect(root).toContain("<SiteHeader");
    expect(root).toContain("isOwner={data.isOwner}");
    expect(siteHeader).toContain("{isOwner ? (");
    expect(siteHeader).toContain('to="/admin"');
    expect(siteHeader).toContain('{t("Admin")}');
  });

  it("keeps each administration page connected to the console", () => {
    for (const page of [collaborators, integrations, mcpTokens]) {
      expect(page).toContain('to="/admin"');
    }
  });
});
