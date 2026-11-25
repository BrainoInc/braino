import { workspaceUsageResponse } from "@braino/host";
import { getCurrentUser } from "~/lib/current-user.server";

export async function loader({
  request,
  params,
}: { request: Request; params: { workspaceHandle: string } }) {
  const user = await getCurrentUser(request);
  return workspaceUsageResponse(new URL(request.url), params.workspaceHandle, user?.id ?? null);
}
