import { withClient } from "@doco/db";
import {
  connectGithubRepository,
  getGithubAppRegistration,
  getSingleWorkspaceState,
  readGithubSetupState,
  syncGithubConnection,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { githubEncryptionKey } from "~/lib/github-app.server";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

async function setupContext(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/");
  const workspace = await withClient(getSingleWorkspaceState);
  if (!workspace.initialized) throw redirect("/");
  const url = new URL(request.url);
  const sealedState = url.searchParams.get("state") ?? "";
  const installationId = Number(url.searchParams.get("installation_id"));
  const state = readGithubSetupState(sealedState, githubEncryptionKey());
  if (
    state.purpose !== "install" ||
    state.workspaceId !== workspace.workspace.id ||
    state.userId !== user.id ||
    !Number.isInteger(installationId) ||
    installationId <= 0
  ) {
    throw new Response("GitHub installation does not match this workspace owner.", { status: 403 });
  }
  const registration = await withClient((client) =>
    getGithubAppRegistration(client, {
      workspaceId: workspace.workspace.id,
      encryptionKey: githubEncryptionKey(),
    }),
  );
  if (!registration) throw redirect("/integrations");
  return { user, workspace: workspace.workspace, sealedState, installationId, registration };
}

export async function loader({ request }: { request: Request }) {
  const context = await setupContext(request);
  const [installation, repositories] = await Promise.all([
    context.registration.plugin.github.installation(context.installationId),
    context.registration.plugin.github.repositories(context.installationId),
  ]);
  return {
    account: installation.account,
    repositories,
    state: context.sealedState,
    installationId: context.installationId,
  };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const state = text(form, "state");
  const installationId = text(form, "installation_id");
  const requestWithState = new Request(
    `${new URL(request.url).origin}/integrations/github/install?state=${encodeURIComponent(state)}&installation_id=${encodeURIComponent(installationId)}`,
    { headers: request.headers },
  );
  const context = await setupContext(requestWithState);
  const connection = await connectGithubRepository(withClient, {
    workspaceId: context.workspace.id,
    userId: context.user.id,
    installationId: context.installationId,
    repository: text(form, "repository"),
    plugin: context.registration.plugin,
  });
  await syncGithubConnection(withClient, {
    connectionId: connection.id,
    userId: context.user.id,
    plugin: context.registration.plugin,
  });
  throw redirect("/integrations");
}

export default function GithubInstallPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader title={t("Connect GitHub")}>
        <p className="text-sm text-muted-foreground">
          {t("Choose the repository Braino imports from {account}.", { account: data.account })}
        </p>
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle>{t("Repository")}</CardTitle>
          <CardDescription>
            {t(
              "The App sends signed webhooks directly to this Braino deployment and mints short-lived installation tokens for sync and checks.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="state" value={data.state} />
            <input type="hidden" name="installation_id" value={data.installationId} />
            <select name="repository" required className="w-full rounded-md px-3 py-2 text-sm">
              {data.repositories.map((repository) => (
                <option key={repository.fullName} value={repository.fullName}>
                  {repository.fullName}
                </option>
              ))}
            </select>
            <div className="text-end">
              <button
                type="submit"
                className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground"
              >
                {t("Connect and sync")}
              </button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </PageMain>
  );
}
