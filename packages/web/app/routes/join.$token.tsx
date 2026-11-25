import { withClient } from "@braino/db";
import { AccountLinkError, acceptWorkspaceInvitation, getWorkspaceInvitation } from "@braino/host";
import { useT } from "@braino/shared/i18n/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@braino/ui";
import { NarrowPageMain } from "@braino/ui";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { hashPassword, passwordError } from "~/lib/password.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";
import { createSessionCookie } from "~/lib/session.server";
import { requestTranslator } from "~/locales/catalog";

function rawText(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function text(form: FormData, name: string): string {
  return rawText(form, name).trim();
}

export async function loader({ params }: { params: { token?: string } }) {
  try {
    const invitation = await withClient((client) =>
      getWorkspaceInvitation(client, { token: params.token ?? "" }),
    );
    return { valid: true as const, invitation };
  } catch (error) {
    if (error instanceof AccountLinkError) return { valid: false as const };
    throw error;
  }
}

export async function action({
  request,
  params,
}: { request: Request; params: { token?: string } }) {
  const t = await requestTranslator(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: t(error.message) };
    throw error;
  }
  const password = rawText(form, "password");
  const invalidPassword = passwordError(password, t);
  if (invalidPassword) return { error: invalidPassword };
  try {
    const passwordHash = await hashPassword(password);
    const accepted = await withClient((client) =>
      acceptWorkspaceInvitation(client, {
        token: params.token ?? "",
        username: text(form, "username"),
        name: text(form, "name"),
        passwordHash,
      }),
    );
    return redirect("/", {
      headers: {
        "Set-Cookie": createSessionCookie({
          userId: accepted.user.id,
          stamp: accepted.user.stamp,
        }),
      },
    });
  } catch (error) {
    if (error instanceof AccountLinkError) return { error: t(error.message) };
    throw error;
  }
}

export default function JoinWorkspace() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { error?: string } | undefined;
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <nav className="font-mono text-[11px] text-muted-foreground">
        <Link to="/" className="hover:underline">
          {"Braino"}
        </Link>{" "}
        › {t("Invitation")}
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>
            {data.valid
              ? t("Join {workspace}", { workspace: data.invitation.workspace.name })
              : t("Invitation unavailable")}
          </CardTitle>
          <CardDescription>
            {data.valid
              ? t("Create your account for {email}.", { email: data.invitation.email })
              : t("This invitation has expired, was revoked, or was already used.")}
          </CardDescription>
        </CardHeader>
        {data.valid ? (
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Your name")}</span>
                <input name="name" required className="w-full rounded-md px-3 py-2 text-sm" />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Username")}</span>
                <input
                  name="username"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  autoComplete="username"
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Password")}</span>
                <input
                  name="password"
                  type="password"
                  minLength={12}
                  maxLength={200}
                  autoComplete="new-password"
                  required
                  className="w-full rounded-md px-3 py-2 text-sm"
                />
              </label>
              {actionData?.error ? (
                <p role="alert" className="text-xs text-destructive">
                  {actionData.error}
                </p>
              ) : null}
              <button
                type="submit"
                className="neu-button w-full rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
              >
                {t("Create account and join")}
              </button>
            </Form>
          </CardContent>
        ) : null}
      </Card>
    </NarrowPageMain>
  );
}
