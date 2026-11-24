import { getWorkspaceRole, withClient } from "@doco/db";
import { measureWorkspaceQuery, searchWorkspaceRecords } from "@doco/host";

/** A signed-in user may have lost membership since their session was issued. */
export async function searchAsWorkspaceMember(input: {
  workspaceId: string;
  userId: string;
  query: string;
  limit?: number;
}) {
  if (!input.query || !(await getWorkspaceRole(input.workspaceId, input.userId))) return [];
  return measureWorkspaceQuery(
    () => withClient((client) => searchWorkspaceRecords(client, input)),
    () => true,
    input.workspaceId,
  );
}
