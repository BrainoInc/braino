import { withClient } from "@doco/db";
import {
  GithubConnectionError,
  deliverGithubAppWebhook,
  getOnlyGithubAppRegistration,
} from "@doco/host";
import { githubEncryptionKey } from "~/lib/github-app.server";
import { MAX_JSON_BODY_BYTES, RequestBodyError, readBoundedText } from "~/lib/request-body.server";

export async function action({ request }: { request: Request }) {
  let body: string;
  try {
    body = await readBoundedText(request, MAX_JSON_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  try {
    const registration = await withClient((client) =>
      getOnlyGithubAppRegistration(client, { encryptionKey: githubEncryptionKey() }),
    );
    if (!registration) {
      return Response.json({ error: "GitHub App is not configured." }, { status: 404 });
    }
    const result = await deliverGithubAppWebhook(withClient, {
      plugin: registration.plugin,
      headers: {
        "x-github-delivery": request.headers.get("x-github-delivery") ?? "",
        "x-github-event": request.headers.get("x-github-event") ?? "",
        "x-hub-signature-256": request.headers.get("x-hub-signature-256") ?? "",
      },
      body,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof GithubConnectionError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status });
    }
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 500;
    return Response.json(
      { error: error instanceof Error ? error.message : "GitHub webhook failed." },
      { status },
    );
  }
}
