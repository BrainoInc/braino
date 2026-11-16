import { withClient } from "@doco/db";
import {
  PluginInvocationError,
  enqueueTeamChatEvents,
  getSingleWorkspaceState,
  resolveWorkspaceTeamChatPlugin,
} from "@doco/host";
import type { PluginEvent } from "@doco/plugin-runtime";
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
  if (!state.initialized) return json("Slack is not connected.", 404);
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) return json("The plugin service is not configured.", 503);

  return withClient(async (client) => {
    const plugin = await resolveWorkspaceTeamChatPlugin(client, {
      workspaceId: state.workspace.id,
      encryptionKey,
      host,
    });
    if (!plugin) return json("Slack is not connected.", 404);

    let events: readonly PluginEvent[];
    try {
      events = await plugin.receive({
        body,
        headers: Object.fromEntries(request.headers.entries()),
        receivedAt: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      if (error instanceof PluginInvocationError) {
        return json("Plugin gateway verification failed.", 401);
      }
      throw error;
    }

    await enqueueTeamChatEvents(client, {
      workspaceId: state.workspace.id,
      installationId: plugin.installation.installationId,
      events,
    });
    return Response.json({ ok: true });
  });
}
