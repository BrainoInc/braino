import { withClient } from "@braino/db";
import {
  GithubConnectionError,
  PluginInvocationError,
  deliverGithubGatewayWebhook,
  getSingleWorkspaceState,
  resolveWorkspaceGithubPlugin,
} from "@braino/host";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import { MAX_JSON_BODY_BYTES, RequestBodyError, readBoundedText } from "~/lib/request-body.server";

function json(error: string, status: number) {
  return Response.json({ error }, { status });
}

/** The installation-scoped endpoint called only by the Braino plugin gateway. */
export async function action({ request }: { request: Request }): Promise<Response> {
  if (request.method !== "POST") return json("Method not allowed.", 405);

  let body: string;
  try {
    body = await readBoundedText(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return json(error.message, error.status);
    throw error;
  }

  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return json("GitHub is not connected.", 404);
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) return json("The plugin service is not configured.", 503);

  try {
    const result = await withClient(async (client) => {
      const plugin = await resolveWorkspaceGithubPlugin(client, {
        workspaceId: state.workspace.id,
        encryptionKey,
        host,
      });
      if (!plugin) return null;
      return deliverGithubGatewayWebhook(withClient, {
        plugin,
        body,
        headers: Object.fromEntries(request.headers.entries()),
      });
    });
    return result ? Response.json(result) : json("GitHub is not connected.", 404);
  } catch (error) {
    if (error instanceof PluginInvocationError) {
      return json("Plugin gateway verification failed.", 401);
    }
    if (error instanceof GithubConnectionError) return json(error.message, error.status);
    throw error;
  }
}
