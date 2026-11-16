import { githubAppSetup } from "@doco/connector-plugins";
import { withClient } from "@doco/db";
import {
  createGithubSetupState,
  getSingleWorkspaceState,
  readGithubSetupState,
  saveGithubAppRegistration,
} from "@doco/host";
import { redirect } from "react-router";
import { getCurrentUser } from "~/lib/current-user.server";
import { githubEncryptionKey } from "~/lib/github-app.server";

export async function loader({ request }: { request: Request }) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const sealedState = url.searchParams.get("state") ?? "";
  const state = readGithubSetupState(sealedState, githubEncryptionKey());
  const workspace = await withClient(getSingleWorkspaceState);
  if (
    state.purpose !== "create" ||
    !workspace.initialized ||
    state.workspaceId !== workspace.workspace.id ||
    state.userId !== user.id
  ) {
    throw new Response("GitHub setup state does not match this workspace owner.", { status: 403 });
  }
  const registration = await githubAppSetup().exchangeManifestCode(code);
  await withClient((client) =>
    saveGithubAppRegistration(client, {
      workspaceId: workspace.workspace.id,
      userId: user.id,
      registration,
      encryptionKey: githubEncryptionKey(),
    }),
  );
  const installState = createGithubSetupState(
    { workspaceId: workspace.workspace.id, userId: user.id, purpose: "install" },
    githubEncryptionKey(),
  );
  throw redirect(
    `${registration.htmlUrl}/installations/new?state=${encodeURIComponent(installState)}`,
  );
}
