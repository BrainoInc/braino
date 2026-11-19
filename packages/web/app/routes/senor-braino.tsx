import { withClient } from "@doco/db";
import {
  getSingleWorkspaceState,
  listWorkspaceChatMessages,
  resolveWorkspaceChatProvider,
  sendWorkspaceChatMessage,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Form, Link, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { metaTranslator } from "~/locales/catalog";

export function meta({ matches }: { matches: Parameters<typeof metaTranslator>[0] }) {
  const t = metaTranslator(matches);
  return [{ title: t("Señor Braino · Braino") }];
}

async function context(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) throw redirect("/?next=/senor-braino");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  return { user, workspace: state.workspace };
}

export async function loader({ request }: { request: Request }) {
  const { user, workspace } = await context(request);
  const messages = await withClient((client) =>
    listWorkspaceChatMessages(client, { workspaceId: workspace.id, userId: user.id }),
  );
  return { messages, workspace };
}

export async function action({ request }: { request: Request }) {
  const { user, workspace } = await context(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: error.message };
    throw error;
  }
  const question = String(form.get("question") ?? "").trim();
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) return { error: "The chat model service is not configured." };
  try {
    await withClient(async (client) => {
      const chat = await resolveWorkspaceChatProvider(client, {
        workspaceId: workspace.id,
        encryptionKey,
        host,
      });
      if (!chat) throw new Error("Set up a chat model before asking Señor Braino.");
      await sendWorkspaceChatMessage(client, {
        workspaceId: workspace.id,
        userId: user.id,
        question,
        baseUrl: (process.env.DOCO_PUBLIC_HOST ?? new URL(request.url).origin).replace(/\/+$/, ""),
        chat,
      });
    });
    return redirect("/senor-braino#latest");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Señor Braino could not answer." };
  }
}

function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s)]+)/g);
  let offset = 0;
  const keyedParts = parts.map((part) => {
    const start = offset;
    offset += part.length;
    return { part, start };
  });
  return (
    <p className="whitespace-pre-wrap text-sm leading-6">
      {keyedParts.map(({ part, start }) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={`${start}-${part}`}
            href={part}
            className="break-all text-primary underline underline-offset-2"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}

export default function SenorBrainoPage() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  const navigation = useNavigation();
  const asking = navigation.state !== "idle";
  return (
    <PageMain className="flex min-h-full max-w-4xl flex-col gap-5 py-6">
      <PageHeader
        breadcrumb={
          <nav className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
            <Link to="/">{"Braino"}</Link>
            <span aria-hidden>›</span>
            <span>{data.workspace.handle}</span>
            <span aria-hidden>›</span>
            <span>{t("Señor Braino")}</span>
          </nav>
        }
        title={t("Señor Braino")}
      >
        <p className="text-xs text-muted-foreground">
          {t("Ask about anything in this workspace. Answers stay grounded in its records.")}
        </p>
      </PageHeader>

      <Card className="flex-1">
        <CardContent className="space-y-4 py-5">
          {data.messages.length ? (
            data.messages.map((message, index) => (
              <article
                id={index === data.messages.length - 1 ? "latest" : undefined}
                key={message.id}
                className={`max-w-[90%] rounded-lg px-4 py-3 ${
                  message.role === "user"
                    ? "ms-auto bg-primary text-primary-foreground"
                    : "neu-surface me-auto bg-card"
                }`}
              >
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wide opacity-70">
                  {message.role === "user" ? t("You") : t("Señor Braino")}
                </p>
                <MessageText text={message.text} />
              </article>
            ))
          ) : (
            <div className="py-12 text-center">
              <p className="text-lg font-semibold">{t("Ask your workspace")}</p>
              <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                {t(
                  "Señor Braino searches the records you can access, then answers through your configured chat model.",
                )}
              </p>
            </div>
          )}
          {asking ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("Señor Braino is thinking…")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Form method="post" className="neu-surface sticky bottom-4 rounded-lg bg-card p-3">
        <label className="sr-only" htmlFor="senor-braino-question">
          {t("Ask Señor Braino")}
        </label>
        <div className="flex items-end gap-2">
          <textarea
            id="senor-braino-question"
            name="question"
            rows={2}
            maxLength={4000}
            required
            disabled={asking}
            placeholder={t("Ask about anything in this workspace")}
            className="min-h-16 flex-1 resize-y rounded-md px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={asking}
            className="neu-button rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
          >
            {asking ? t("Thinking…") : t("Ask")}
          </button>
        </div>
        {actionData?.error ? (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {actionData.error}
          </p>
        ) : null}
      </Form>
    </PageMain>
  );
}
