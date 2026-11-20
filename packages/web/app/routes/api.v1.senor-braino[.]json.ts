import { withClient } from "@doco/db";
import {
  getSingleWorkspaceState,
  listWorkspaceChatMessages,
  resolveWorkspaceChatProvider,
  sendWorkspaceChatMessage,
} from "@doco/host";
import { getCurrentUser } from "~/lib/current-user.server";
import { pluginHostConnection, pluginSecretsKey } from "~/lib/model-setup.server";
import {
  MAX_FORM_BODY_BYTES,
  RequestBodyError,
  readBoundedUrlEncodedForm,
} from "~/lib/request-body.server";

async function context(request: Request) {
  const user = await getCurrentUser(request);
  if (!user) throw Response.json({ error: "Sign in to use Señor Braino." }, { status: 401 });
  const state = await withClient(getSingleWorkspaceState);
  if (!state.initialized) {
    throw Response.json({ error: "Set up the workspace first." }, { status: 409 });
  }
  return { user, workspace: state.workspace };
}

async function conversation(workspaceId: string, userId: string) {
  return withClient((client) => listWorkspaceChatMessages(client, { workspaceId, userId }));
}

export async function loader({ request }: { request: Request }) {
  const { user, workspace } = await context(request);
  return Response.json({ messages: await conversation(workspace.id, user.id), workspace });
}

export async function action({ request }: { request: Request }) {
  const { user, workspace } = await context(request);
  let form: FormData;
  try {
    form = await readBoundedUrlEncodedForm(request, MAX_FORM_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
  const question = String(form.get("question") ?? "").trim();
  if (!question) return Response.json({ error: "Write a question first." }, { status: 400 });

  const encryptionKey = pluginSecretsKey();
  const host = pluginHostConnection();
  if (!encryptionKey || !host) {
    return Response.json({ error: "The chat model service is not configured." }, { status: 503 });
  }
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
    return Response.json({ messages: await conversation(workspace.id, user.id), workspace });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Señor Braino could not answer." },
      { status: 502 },
    );
  }
}
