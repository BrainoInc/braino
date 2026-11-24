import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import {
  readWorkspaceUsage,
  recordWorkspaceOperation,
  withClient,
  withTransaction,
  workspaceUsageWindow,
} from "@doco/db";

const queryWorkspaces = new AsyncLocalStorage<Set<string>>();

/** A read can discover its authorized workspace(s) below the transport boundary. */
export function includeQueryWorkspace(workspaceId: string): void {
  queryWorkspaces.getStore()?.add(workspaceId);
}

/** Meter an externally initiated read once per workspace, after its result is known. */
export async function measureWorkspaceQuery<T>(
  run: () => Promise<T>,
  succeeded: (result: T) => boolean,
  workspaceId?: string,
): Promise<T> {
  const workspaces = new Set(workspaceId ? [workspaceId] : []);
  const result = await queryWorkspaces.run(workspaces, run);
  if (workspaces.size && succeeded(result)) {
    const operationId = randomUUID();
    await withTransaction(async (client) => {
      for (const id of workspaces) await recordWorkspaceOperation(client, id, "query", operationId);
    });
  }
  return result;
}

/** Both hosts authenticate the session locally; workspace membership is checked here. */
export async function workspaceUsageResponse(
  url: URL,
  handle: string,
  userId: string | null,
): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    Response.json(body, {
      status,
      headers: { "Cache-Control": "private, no-store" },
    });
  if (!userId) return json({ error: "Authentication required." }, 401);
  const window = workspaceUsageWindow(url.searchParams);
  if (!window)
    return json({ error: "Use a valid start and end at or before the current time." }, 400);
  return withClient(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT w.id FROM workspaces w JOIN workspace_users u ON u.workspace_id = w.id
       WHERE w.handle = $1 AND u.user_id = $2`,
      [handle, userId],
    );
    const workspace = rows[0];
    return workspace
      ? json(await readWorkspaceUsage(client, workspace.id, window))
      : json({ error: "Workspace not found." }, 404);
  });
}
