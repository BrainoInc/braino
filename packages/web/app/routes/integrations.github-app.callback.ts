import { withClient } from "@braino/db";
import {
  PluginInstallationError,
  connectWorkspaceGithubPlugin,
  getSingleWorkspaceState,
  getWorkspaceRole,
} from "@braino/host";
import { redirect } from "react-router";
import { bundledPlugin } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  brainoPluginGatewayUrl,
  verifyPluginGatewayState,
} from "~/lib/plugin-gateway-state.server";

const GITHUB_PLUGIN_ID = "braino.github";

interface GatewayExchange {
  installationId: string;
  gatewaySecret: string;
  provider: "github";
  externalAccountId: string;
  accountName: string;
}

function exchange(value: unknown): GatewayExchange {
  const input = value as Partial<GatewayExchange>;
  if (
    !input ||
    typeof input.installationId !== "string" ||
    typeof input.gatewaySecret !== "string" ||
    input.provider !== "github" ||
    typeof input.externalAccountId !== "string" ||
    typeof input.accountName !== "string"
  ) {
    throw new Error("The plugin gateway returned an invalid installation.");
  }
  return input as GatewayExchange;
}

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const workspaceState = await withClient(getSingleWorkspaceState);
  if (!workspaceState.initialized) throw redirect("/");
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) throw redirect("/integrations/github-app?error=plugin-service");
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateValue = url.searchParams.get("state");
  if (!code || !stateValue) throw redirect("/integrations/github-app?error=gateway");
  let state: { userId: string; workspaceId: string };
  try {
    state = verifyPluginGatewayState(stateValue, "github", encryptionKey);
  } catch {
    throw redirect("/integrations/github-app?error=state");
  }
  if (state.userId !== user.id || state.workspaceId !== workspaceState.workspace.id) {
    throw redirect("/integrations/github-app?error=state");
  }
  const role = await withClient((client) =>
    getWorkspaceRole(client, workspaceState.workspace.id, user.id),
  );
  if (role !== "owner") throw new Response("Owner access required", { status: 403 });
  const gateway = brainoPluginGatewayUrl();
  const response = await fetch(`${gateway}/v1/installations/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw redirect("/integrations/github-app?error=exchange");
  const installed = exchange(await response.json());
  const bundled = await bundledPlugin(GITHUB_PLUGIN_ID);
  if (!bundled) throw redirect("/integrations/github-app?error=plugin-missing");
  try {
    await withClient((client) =>
      connectWorkspaceGithubPlugin(client, {
        workspaceId: workspaceState.workspace.id,
        userId: user.id,
        manifest: bundled.manifest,
        component: bundled.component,
        configuration: {
          gateway_url: gateway,
          installation_id: installed.installationId,
        },
        secrets: { gateway_secret: installed.gatewaySecret },
        encryptionKey,
        host,
      }),
    );
  } catch (error) {
    if (error instanceof PluginInstallationError) {
      throw redirect(`/integrations/github-app?error=${encodeURIComponent(error.code)}`);
    }
    throw error;
  }
  throw redirect("/integrations/github-app?connected=1");
}
