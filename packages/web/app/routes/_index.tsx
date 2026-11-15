import { withClient } from "@doco/db";
import {
  clearPasswordSignInAttempts,
  getSingleWorkspaceState,
  getWorkspaceModelPluginReadiness,
  initializeSingleWorkspace,
  installRequiredModelPlugins,
  reservePasswordSignInAttempt,
  revokeUserSessions,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollectionTypeIcon } from "~/components/collection-type-icon";
import { PageHeader } from "~/components/page-header";
import { NarrowPageMain, PageMain } from "~/components/page-main";
import { bundledModelProviderPlugins } from "~/lib/bundled-model-plugins.server";
import { getCurrentUser } from "~/lib/current-user.server";
import { MODEL_PROVIDER_DEFAULTS, modelProvider } from "~/lib/model-provider-catalog";
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
  goal: string;
  template_handle: string;
  items: number;
  last_updated_at: string | null;
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
      screen: "models-required";
      workspaceName: string;
      chat: "missing" | "invalid" | "ambiguous" | "ready";
      embedding: "missing" | "invalid" | "ambiguous" | "ready";
    }
  | {
      screen: "dashboard";
      workspace: WorkspaceView;
      user: { id: string; email: string; username: string; name: string };
      collections: DashboardCollection[];
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
  if (!modelPlugins.ready) {
    return {
      screen: "models-required",
      workspaceName: state.workspace.name,
      chat: modelPlugins.chat,
      embedding: modelPlugins.embedding,
    };
  }
  return withClient(async (client) => {
    const workspaceResult = await client.query<WorkspaceView>(
      "SELECT id, handle, name, constitution FROM workspaces WHERE id = $1",
      [state.workspace.id],
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) throw new Error("The Braino workspace is missing.");
    const result = await client.query<DashboardCollection>(
      `SELECT c.id, c.handle, c.goal,
              coalesce(c.data->>'template_handle', '') AS template_handle,
              count(n.id)::int AS items,
              max(n.updated_at)::text AS last_updated_at
         FROM collections c
         JOIN workspace_users wu ON wu.workspace_id = c.workspace_id
         LEFT JOIN nodes n ON n.collection_id = c.id
        WHERE c.workspace_id = $1 AND wu.user_id = $2 AND c.deleted_at IS NULL
        GROUP BY c.id, c.handle, c.goal, c.data
        ORDER BY c.handle`,
      [workspace.id, user.id],
    );
    return { screen: "dashboard", workspace, user, collections: result.rows };
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

function encryptionKey(): string {
  const value = process.env.DOCO_ENCRYPTION_KEY?.trim();
  if (!value || value.length < 32) {
    throw new Error("DOCO_ENCRYPTION_KEY must contain at least 32 characters.");
  }
  return value;
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
    const user = await getCurrentUser(request);
    if (user) await withClient((client) => revokeUserSessions(client, user.id));
    return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
  }

  const state = await withClient(getSingleWorkspaceState);
  if (intent === "install_model_provider") {
    if (!state.initialized) return formError(t("Create the workspace first."));
    const user = await getCurrentUser(request);
    if (!user) return formError(t("Sign in first."));
    const provider = modelProvider(text(form, "provider"));
    if (!provider) return formError(t("Choose a supported AI provider."));
    const chatModel = text(form, "chat_model");
    const embeddingModel = text(form, "embedding_model");
    const embeddingDimensions = text(form, "embedding_dimensions");
    if (!chatModel || !embeddingModel) {
      return formError(t("Both model plugins require a model."));
    }
    if (!Number.isInteger(Number(embeddingDimensions)) || Number(embeddingDimensions) < 1) {
      return formError(t("Embedding dimensions must be a positive integer."));
    }
    const apiKey = text(form, "api_key");
    if (provider === "openai" && !apiKey) {
      return formError(t("Enter your OpenAI API key."));
    }
    try {
      const plugins = await bundledModelProviderPlugins(provider);
      const secret =
        provider === "openai"
          ? { secrets: { api_key: apiKey }, encryptionKey: encryptionKey() }
          : {};
      await withClient((client) =>
        installRequiredModelPlugins(client, {
          workspaceId: state.workspace.id,
          userId: user.id,
          chat: {
            ...plugins.chat,
            configuration: { model: chatModel },
            ...secret,
          },
          embedding: {
            ...plugins.embedding,
            configuration: { model: embeddingModel, dimensions: embeddingDimensions },
            ...secret,
          },
        }),
      );
      return redirect("/");
    } catch (caught) {
      return formError(caught instanceof Error ? t(caught.message) : t("Plugin setup failed."));
    }
  }
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
  if (data.screen === "models-required") {
    return <ModelsRequired data={data} error={actionData?.error} />;
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
          {t("Set up the owner and workspace. Next, you will choose how Braino gets its AI.")}
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

function ModelsRequired({
  data,
  error,
}: {
  data: Extract<LoaderData, { screen: "models-required" }>;
  error?: string;
}) {
  const t = useT();
  const status = (value: "missing" | "invalid" | "ambiguous" | "ready") =>
    value === "ready" ? t("Ready") : t("Setup required");
  return (
    <PageMain className="space-y-5 py-6">
      <PageHeader
        breadcrumb={<Breadcrumb>{t("Step 2 of 2")}</Breadcrumb>}
        title={t("Power your Braino")}
      >
        <p className="max-w-2xl text-xs text-muted-foreground">
          {t(
            "Braino needs two things: one to answer questions and one to make your workspace searchable. Choose a provider and Braino will install both required plugins.",
          )}
        </p>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-3 text-xs">
            <div>
              <p className="font-semibold">{t("Answers and reasoning")}</p>
              <p className="text-muted-foreground">{t("Writes answers and runs agent tasks.")}</p>
            </div>
            <span className="font-mono">{status(data.chat)}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-3 text-xs">
            <div>
              <p className="font-semibold">{t("Searchable memory")}</p>
              <p className="text-muted-foreground">{t("Finds the right workspace knowledge.")}</p>
            </div>
            <span className="font-mono">{status(data.embedding)}</span>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <CardTitle>{"OpenAI"}</CardTitle>
              <span className="rounded-full bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary">
                {t("Fastest setup")}
              </span>
            </div>
            <CardDescription>
              {t(
                "Use your existing OpenAI API account. OpenAI processes requests and bills usage to that account.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="install_model_provider" />
              <input type="hidden" name="provider" value="openai" />
              <Field
                label={t("OpenAI API key")}
                name="api_key"
                type="password"
                autoComplete="off"
                placeholder="sk-…"
                required
              />
              <p className="text-[11px] text-muted-foreground">
                {t(
                  "Braino uses one key for both plugins, stores it encrypted and never displays it.",
                )}{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline underline-offset-2"
                >
                  {t("Find or create an API key")}
                </a>
              </p>
              <details className="rounded-md border border-border/70 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-semibold">{t("Advanced settings")}</summary>
                <div className="mt-3 grid gap-3">
                  <Field
                    label={t("Chat model")}
                    name="chat_model"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.openai.chatModel}
                    required
                  />
                  <Field
                    label={t("Embedding model")}
                    name="embedding_model"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.openai.embeddingModel}
                    required
                  />
                  <Field
                    label={t("Embedding dimensions")}
                    name="embedding_dimensions"
                    type="number"
                    min="1"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.openai.embeddingDimensions}
                    required
                  />
                </div>
              </details>
              <button
                type="submit"
                className="neu-button w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {t("Connect OpenAI")}
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("Local models")}</CardTitle>
            <CardDescription>
              {t(
                "Keep prompts and search local with Ollama. No provider account is required, but this server must run the optional models service.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="install_model_provider" />
              <input type="hidden" name="provider" value="ollama" />
              <div className="neu-well rounded-md px-3 py-2 text-xs text-muted-foreground">
                {t(
                  "Best for privacy and offline use. Initial model downloads can take several minutes.",
                )}
              </div>
              <details className="rounded-md border border-border/70 px-3 py-2 text-xs">
                <summary className="cursor-pointer font-semibold">{t("Advanced settings")}</summary>
                <div className="mt-3 grid gap-3">
                  <Field
                    label={t("Chat model")}
                    name="chat_model"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.ollama.chatModel}
                    required
                  />
                  <Field
                    label={t("Embedding model")}
                    name="embedding_model"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.ollama.embeddingModel}
                    required
                  />
                  <Field
                    label={t("Embedding dimensions")}
                    name="embedding_dimensions"
                    type="number"
                    min="1"
                    defaultValue={MODEL_PROVIDER_DEFAULTS.ollama.embeddingDimensions}
                    required
                  />
                </div>
              </details>
              <button
                type="submit"
                className="neu-button w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                {t("Use local models")}
              </button>
            </Form>
          </CardContent>
        </Card>
      </div>
      <ErrorMessage error={error} />
      <p className="text-center font-mono text-[11px] text-muted-foreground">
        {t("You can manage installed plugins later from Admin.")} · {data.workspaceName}
      </p>
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
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-mono text-xs text-muted-foreground">{data.workspace.id}</p>
          <div className="flex items-center gap-2">
            <Link
              to="/mcp-tokens"
              className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              {"MCP"}
            </Link>
            <Link
              to="/collaborators"
              className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              {t("Collaborators")}
            </Link>
          </div>
        </div>
      </PageHeader>

      <Card>
        <CardContent className="space-y-3 pt-4">
          <div className="flex flex-wrap items-center gap-1.5">
            {data.collections.map((collection) => (
              <Link
                to={`/${collection.handle}`}
                title={collection.handle}
                aria-label={collection.handle}
                className="neu-button neu-small flex h-7 w-7 items-center justify-center rounded-md"
                key={collection.id}
              >
                <CollectionTypeIcon template={collection.template_handle} />
              </Link>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("{count, plural, one {# collection} other {# collections}}", {
              count: data.collections.length,
            })}{" "}
            · {t("Signed in as {name}", { name: data.user.name })}
          </p>
        </CardContent>
      </Card>

      <section className="neu-surface rounded-lg bg-card px-4 py-3">
        <h2 className="text-sm font-semibold">{t("Collections in this workspace")}</h2>
        <ul className="mt-3 space-y-1.5">
          {data.collections.map((collection) => (
            <li className="flex min-w-0 items-baseline gap-2" key={collection.id}>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
              <Link
                to={`/${collection.handle}`}
                className="min-w-0 truncate text-sm font-semibold text-primary hover:underline"
              >
                {collection.handle}
              </Link>
              <span className="text-[11px] text-muted-foreground">
                {t("({count, plural, one {# record} other {# records}})", {
                  count: collection.items,
                })}
              </span>
              <span className="ms-auto hidden text-[11px] text-muted-foreground sm:block">
                {collection.last_updated_at ? t("has activity") : t("no activity yet")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <Card>
        <CardContent className="px-6 py-7 sm:px-10 sm:py-9">
          <article>
            {t.rich("<title>Constitution</title><subtitle>of {workspace}</subtitle>", {
              title: (children) => (
                <h2 className="text-center text-lg font-semibold uppercase tracking-[0.2em] sm:text-2xl sm:tracking-[0.25em]">
                  {children}
                </h2>
              ),
              subtitle: (children) => (
                <p className="mt-1 text-center font-mono text-[11px] uppercase tracking-[0.3em] text-muted-foreground">
                  {children}
                </p>
              ),
              workspace: data.workspace.handle,
            })}
            <div className="mx-auto mt-4 h-px w-24 bg-border" />
            {paragraphs.length ? (
              <div className="mt-6 space-y-4 hyphens-auto text-sm leading-7">
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
              <p className="mt-6 text-center text-sm italic text-muted-foreground">
                {t("No constitution has been written yet.")}
              </p>
            )}
          </article>
        </CardContent>
      </Card>
    </PageMain>
  );
}
