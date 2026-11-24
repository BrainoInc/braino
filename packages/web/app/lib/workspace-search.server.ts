import { getWorkspaceRole, recordQueryEvent, withClient } from "@doco/db";
import { searchWorkspaceRecords } from "@doco/host";

/** A signed-in user may have lost membership since their session was issued. */
export async function searchAsWorkspaceMember(input: {
  workspaceId: string;
  source: "ui" | "api";
  userId: string;
  query: string;
  limit?: number;
}) {
  if (!input.query || !(await getWorkspaceRole(input.workspaceId, input.userId))) return [];
  return withClient(async (client) => {
    const results = await searchWorkspaceRecords(client, input);
    await recordQueryEvent(client, {
      workspaceId: input.workspaceId,
      actor: input.userId,
      source: input.source,
      searchedRecords: true,
      metadata: input.source === "ui" ? { surface: "website" } : { auth: "session" },
    });
    return results;
  });
}
