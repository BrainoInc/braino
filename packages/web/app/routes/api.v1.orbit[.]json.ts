import { withClient } from "@braino/db";
import { getSingleWorkspaceState } from "@braino/host";
import { getCurrentUser } from "~/lib/current-user.server";
import { loadOrbitActivity, sizeCollections } from "~/lib/orbit.server";

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) return Response.json({ error: "Authentication required." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return Response.json({ error: "Finish setup first." }, { status: 409 });
  const activity = await withClient(async (client) => {
    const member = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2
       ) AS present`,
      [state.workspace.id, user.id],
    );
    if (!member.rows[0]?.present) return null;
    const collections = await sizeCollections(client, state.workspace.id);
    return loadOrbitActivity(client, {
      collections,
      workspaceId: state.workspace.id,
      range: "live",
    });
  });
  if (!activity) return Response.json({ error: "Workspace access required." }, { status: 403 });
  return Response.json(activity);
}
