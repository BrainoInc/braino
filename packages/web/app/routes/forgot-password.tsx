import { withClient } from "@doco/db";
import {
  createPasswordResetLink,
  getSingleWorkspaceState,
  resolveWorkspaceEmailPlugin,
} from "@doco/host";
import { useT } from "@doco/shared/i18n/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@doco/ui";
import { NarrowPageMain } from "@doco/ui";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import { publicOrigin } from "~/lib/public-origin.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export async function loader() {
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  return { workspaceName: state.workspace.name };
}

export async function action({ request }: { request: Request }) {
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) return { error: error.message };
    throw error;
  }
  const email = text(form, "email");
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) throw redirect("/");
  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (email && encryptionKey && host) {
    try {
      await withClient(async (client) => {
        const provider = await resolveWorkspaceEmailPlugin(client, {
          workspaceId: state.workspace.id,
          encryptionKey,
          host,
        });
        if (!provider) return;
        const link = await createPasswordResetLink(client, { email });
        if (!link) return;
        const resetUrl = `${publicOrigin(request)}/reset-password/${encodeURIComponent(link.token)}`;
        await provider.send({
          to: [link.email],
          subject: `Reset your ${link.workspaceName} password`,
          text: [
            `Use this secure link to choose a new password for ${link.workspaceName}:`,
            "",
            resetUrl,
            "",
            "This link works once and expires in one hour. If you did not request it, ignore this email.",
          ].join("\n"),
        });
      });
    } catch (error) {
      console.error("Could not send password recovery email", error);
    }
  }
  return { submitted: true };
}

export default function ForgotPassword() {
  const t = useT();
  const data = useLoaderData() as Awaited<ReturnType<typeof loader>>;
  const actionData = useActionData() as { submitted?: boolean; error?: string } | undefined;
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <nav className="font-mono text-[11px] text-muted-foreground">
        <Link to="/" className="hover:underline">
          {t("Sign in")}
        </Link>{" "}
        › {t("Password recovery")}
      </nav>
      <Card>
        <CardHeader>
          <CardTitle>{t("Reset your password")}</CardTitle>
          <CardDescription>
            {t("Braino will email a secure recovery link if the account exists.")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {actionData?.submitted ? (
            <div className="space-y-3 text-sm">
              <p>{t("Check your email for a recovery link. It expires in one hour.")}</p>
              <Link to="/" className="text-primary hover:underline">
                {t("Return to sign in")}
              </Link>
            </div>
          ) : (
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">{t("Email")}</span>
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
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
                {t("Email recovery link")}
              </button>
            </Form>
          )}
          <p className="mt-4 font-mono text-[11px] text-muted-foreground">{data.workspaceName}</p>
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}
