import { withClient } from "@doco/db";
import {
  clearPasswordSignInAttempts,
  getSingleWorkspaceState,
  getWorkspaceModelPluginReadiness,
  initializeSingleWorkspace,
  reservePasswordSignInAttempt,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { Orbit } from "~/components/orbit";
import { PageHeader } from "~/components/page-header";
import { NarrowPageMain, PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { type OrbitActivity, type OrbitLinks, type OrbitRange, orbitRange } from "~/lib/orbit";
import { loadOrbitActivity, loadOrbitLinks, sizeCollections } from "~/lib/orbit.server";
import { hashPassword, passwordError, verifyPassword } from "~/lib/password.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { safeReturnPath } from "~/lib/safe-return-path";
import { clearSessionCookie, createSessionCookie } from "~/lib/session.server";
import { setupTokenError } from "~/lib/setup-token.server";
import { passwordAttemptBuckets } from "~/lib/sign-in.server";
import { metaTranslator, requestTranslator } from "~/locales/catalog";

interface DashboardCollection {
  id: string;
  handle: string;
  template: string | null;
  visibility: "public" | "private";
  items: number;
}

interface WorkspaceView {
  id: string;
  handle: string;
  name: string;
  constitution: string;
}

type LoaderData =
  | { screen: "setup" }
  | { screen: "signin"; workspaceName: string; next: string }
  | {
      screen: "dashboard";
      workspace: WorkspaceView;
      user: { id: string; email: string; username: string; name: string };
      collections: DashboardCollection[];
      range: OrbitRange;
      links: Promise<OrbitLinks>;
      activity: Promise<OrbitActivity>;
    };

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: "Braino" }, { name: "description", content: t("Decisions that stay aligned.") }];
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) return { screen: "setup" };
  const user = await getCurrentUser(request);
  if (!user) {
    return {
      screen: "signin",
      workspaceName: state.workspace.name,
      next: safeReturnPath(new URL(request.url).searchParams.get("next")),
    };
  }
  const modelPlugins = await withClient((client) =>
    getWorkspaceModelPluginReadiness(client, state.workspace.id),
  );
  // Nothing in the workspace works without its two models, so setup comes first.
  if (!modelPlugins.ready) throw redirect("/plugins");
  const range = orbitRange(new URL(request.url).searchParams.get("range"));
  return withClient(async (client) => {
    const workspaceResult = await client.query<WorkspaceView>(
      "SELECT id, handle, name, constitution FROM workspaces WHERE id = $1",
      [state.workspace.id],
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) throw new Error("The Braino workspace is missing.");
    const member = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_users WHERE workspace_id = $1 AND user_id = $2
       ) AS present`,
      [workspace.id, user.id],
    );
    if (!member.rows[0]?.present) throw new Response("Workspace access required.", { status: 403 });
    const collections = await sizeCollections(client, workspace.id);
    const [links, activity] = await Promise.all([
      loadOrbitLinks(client, collections),
      loadOrbitActivity(client, { collections, workspaceId: workspace.id, range }),
    ]);
    return {
      screen: "dashboard",
      workspace,
      user,
      collections,
      range,
      links: Promise.resolve(links),
      activity: Promise.resolve(activity),
    };
  });
}

function rawText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function text(form: FormData, name: string): string {
  return rawText(form, name).trim();
}

function formError(error: string): { error: string } {
  return { error };
}

export async function action({ request }: { request: Request }) {
  const t = await requestTranslator(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return formError(t(error.message));
    }
    throw error;
  }
  const intent = text(form, "intent");
  if (intent === "signout") {
    return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  const state = await withClient(getSingleWorkspaceState);
  if (intent === "setup") {
    if (state.initialized) return formError(t("Braino is already initialized."));
    const invalidSetupToken = setupTokenError(text(form, "setup_token"));
    if (invalidSetupToken) return formError(t(invalidSetupToken));
    const password = rawText(form, "password");
    const error = passwordError(password, t);
    if (error) return formError(error);
    try {
      const ownerPasswordHash = await hashPassword(password);
      const initialized = await withClient((client) =>
        initializeSingleWorkspace(client, {
          workspaceHandle: text(form, "workspace_handle"),
          workspaceName: text(form, "workspace_name"),
          ownerEmail: text(form, "owner_email"),
          ownerUsername: text(form, "owner_username"),
          ownerName: text(form, "owner_name"),
          ownerPasswordHash,
        }),
      );
      return redirect("/", {
        headers: {
          "Set-Cookie": createSessionCookie({
            userId: initialized.owner.id,
            stamp: initialized.owner.stamp,
          }),
        },
      });
    } catch (caught) {
      return formError(caught instanceof Error ? t(caught.message) : t("Setup failed."));
    }
  }

  if (intent === "signin") {
    if (!state.initialized) return formError(t("Finish setup first."));
    const email = text(form, "email").toLowerCase();
    const password = rawText(form, "password");
    const attemptBuckets = passwordAttemptBuckets(request, email);
    const signIn = await withClient(async (client) => {
      const result = await client.query<{
        id: string;
        password_hash: string | null;
        stamp: string;
      }>(
        `SELECT u.id, u.password_hash, u.stamp
           FROM users u
           JOIN workspace_users wu ON wu.user_id = u.id
          WHERE lower(u.email) = $1 AND wu.workspace_id = $2 AND u.deactivated_at IS NULL
          LIMIT 1`,
        [email, state.workspace.id],
      );
      return {
        account: result.rows[0] ?? null,
        reservation: await reservePasswordSignInAttempt(client, attemptBuckets),
      };
    });
    if (!signIn.reservation.allowed) {
      return formError(t("Too many sign-in attempts. Try again later."));
    }
    if (
      !(await verifyPassword(password, signIn.account?.password_hash ?? null)) ||
      !signIn.account
    ) {
      return formError(t("Email or password is incorrect."));
    }
    await withClient((client) => clearPasswordSignInAttempts(client, attemptBuckets));
    return redirect(safeReturnPath(text(form, "next")), {
      headers: {
        "Set-Cookie": createSessionCookie({
          userId: signIn.account.id,
          stamp: signIn.account.stamp,
        }),
      },
    });
  }

  return formError(t("Unknown action."));
}

export default function Home() {
  const data = useLoaderData() as LoaderData;
  const actionData = useActionData() as { error?: string } | undefined;

  if (data.screen === "setup") return <Setup error={actionData?.error} />;
  if (data.screen === "signin") {
    return <SignIn workspaceName={data.workspaceName} next={data.next} error={actionData?.error} />;
  }
  return <WorkspaceHome data={data} />;
}

function Breadcrumb({ children }: { children: React.ReactNode }) {
  return (
    <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
      <Link to="/" className="hover:underline">
        {"Braino"}
      </Link>
      <span aria-hidden>›</span>
      <span>{children}</span>
    </nav>
  );
}

function Field({
  label,
  ...input
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-xs">
      <span className="mb-1 block text-muted-foreground">{label}</span>
      <input
        {...input}
        className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
      />
    </label>
  );
}

function ErrorMessage({ error }: { error?: string }) {
  return error ? (
    <p className="text-xs text-destructive" role="alert">
      {error}
    </p>
  ) : null;
}

function Setup({ error }: { error?: string }) {
  const t = useT();
  return (
    <PageMain className="space-y-4 py-6">
      <PageHeader
        breadcrumb={<Breadcrumb>{t("Step 1 of 2")}</Breadcrumb>}
        title={t("Create your Braino")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Set up the owner and workspace. Next, you will set up the two models Braino needs.")}
        </p>
      </PageHeader>
      <Card>
        <CardContent className="pt-4">
          <Form method="post" className="space-y-4">
            <input type="hidden" name="intent" value="setup" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("Workspace name")} name="workspace_name" required />
              <Field
                label={t("Workspace handle")}
                name="workspace_handle"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                placeholder={"my-workspace"}
              />
              <Field label={t("Your name")} name="owner_name" required />
              <Field
                label={t("Username")}
                name="owner_username"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
              />
              <Field label={t("Email")} name="owner_email" type="email" required />
              <Field
                label={t("Setup token")}
                name="setup_token"
                type="password"
                autoComplete="off"
                required
              />
              <Field
                label={t("Password")}
                name="password"
                type="password"
                minLength={12}
                maxLength={200}
                autoComplete="new-password"
                required
              />
            </div>
            <ErrorMessage error={error} />
            <button
              type="submit"
              className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              {t("Create workspace")}
            </button>
          </Form>
        </CardContent>
      </Card>
    </PageMain>
  );
}

function SignIn({
  workspaceName,
  next,
  error,
}: {
  workspaceName: string;
  next: string;
  error?: string;
}) {
  const t = useT();
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <Breadcrumb>{t("Sign in")}</Breadcrumb>
      <Card>
        <CardHeader>
          <CardTitle>{t("Sign in")}</CardTitle>
          <CardDescription>
            {t("Type the email and password of your Braino account.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="signin" />
            <input type="hidden" name="next" value={next} />
            <Field label={t("Email")} name="email" type="email" autoComplete="username" required />
            <Field
              label={t("Password")}
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
            <button
              type="submit"
              className="neu-button flex w-full items-center justify-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              {t("Sign in")}
            </button>
            <ErrorMessage error={error} />
          </Form>
          <p className="mt-3 text-xs">
            <Link to="/forgot-password" className="text-primary hover:underline">
              {t("Forgot your password?")}
            </Link>
          </p>
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">{workspaceName}</p>
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}

function WorkspaceHome({ data }: { data: Extract<LoaderData, { screen: "dashboard" }> }) {
  const t = useT();
  const paragraphs = data.workspace.constitution
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb>
            {t("Workspaces")} › {data.workspace.handle}
          </Breadcrumb>
        }
        title={data.workspace.handle}
        actions={
          <>
            <Link to="/integrations" className={workspaceActionClass}>
              {t("Sources")}
            </Link>
            <Link to="/times" className={workspaceActionClass}>
              {t("Times")}
            </Link>
            <Link to="/admin" className={workspaceActionClass}>
              {t("Settings")}
            </Link>
            <Link to="/plugins" className={workspaceActionClass}>
              {t("Plugins")}
            </Link>
            <Link to="/collaborators" className={workspaceActionClass}>
              {t("Collaborators")}
            </Link>
            <Link to="/mcp-tokens" className={workspaceActionClass}>
              {t("Agent access")}
            </Link>
          </>
        }
      >
        <p className="font-mono text-xs text-muted-foreground">{data.workspace.id}</p>
      </PageHeader>

      <section>
        <Orbit
          workspace={data.workspace}
          collections={data.collections.map(({ id: _id, ...collection }) => collection)}
          links={data.links}
          activity={data.activity}
          range={data.range}
        />
      </section>

      <div className="grid grid-cols-1 gap-6 @4xl:grid-cols-[minmax(0,1fr)_420px]">
        <Card>
          <CardContent className="px-6 py-7 @xl:px-10 @xl:py-9">
            <article>
              <h2 className="text-center font-serif text-lg font-semibold uppercase tracking-[0.2em] @sm:text-2xl @sm:tracking-[0.25em]">
                {t("Constitution")}
              </h2>
              <p className="mt-1 text-center font-serif text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                {t("of {workspace}", { workspace: data.workspace.handle })}
              </p>
              <div className="mx-auto mt-4 h-px w-24 bg-border" />
              {paragraphs.length ? (
                <div className="mt-6 space-y-4 hyphens-auto font-serif text-sm leading-7 @xl:text-justify">
                  {paragraphs.map((paragraph, index) => (
                    <p
                      key={paragraph}
                      className={
                        index === 0
                          ? "flow-root first-letter:float-start first-letter:me-2 first-letter:mt-1 first-letter:text-5xl first-letter:font-semibold first-letter:leading-none"
                          : undefined
                      }
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              ) : (
                <p className="mt-6 text-center font-serif text-sm italic text-muted-foreground">
                  {t("No constitution has been written yet.")}
                </p>
              )}
            </article>
          </CardContent>
        </Card>

        <aside className="min-w-0 space-y-4">
          <Form method="get" action="/search" className="space-y-2">
            <label htmlFor="workspace-brief" className="block text-sm font-semibold">
              {t("What applies to…?")}
            </label>
            <div className="flex gap-2">
              <input
                id="workspace-brief"
                name="q"
                type="search"
                placeholder={t("Search this workspace")}
                className="w-full rounded-md px-4 py-2.5 text-sm outline-none focus:border-primary"
              />
              <button type="submit" className={workspaceActionClass}>
                {t("Ask")}
              </button>
            </div>
          </Form>
          <Card>
            <CardContent className="p-5 text-xs text-muted-foreground">
              {t("Signed in as {name}", { name: data.user.name })}
            </CardContent>
          </Card>
        </aside>
      </div>
    </PageMain>
  );
}

const workspaceActionClass = "neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold";
