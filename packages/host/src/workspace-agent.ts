import { type PoolClient, recordWorkspaceOperation } from "@doco/db";
import type { ChatCompleteCapability, ChatMessage } from "@doco/plugin-runtime";
import { generateUlid } from "@doco/shared";
import { searchWorkspaceRecords } from "./workspace-search.js";

const SYSTEM_PROMPT = `You are Señor Braino, the assistant for one Braino workspace.
Answer the person's question only from the workspace records supplied below.
Be direct and concise. Preserve useful record links. If the records do not support a claim, say so.`;
const MAX_HISTORY_MESSAGES = 40;

export interface WorkspaceChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: unknown;
  created_at: Date | string;
}

function cleanQuestion(question: string): string {
  return question
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function broadLexicalQuery(question: string): string {
  const ignored = new Set([
    "about",
    "could",
    "does",
    "from",
    "have",
    "into",
    "that",
    "this",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
  ]);
  return [
    ...new Set(
      question
        .toLowerCase()
        .match(/[a-z0-9_-]{4,}/g)
        ?.filter((term) => !ignored.has(term)) ?? [],
    ),
  ].join(" OR ");
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? (block as { text?: unknown }).text
        : "",
    )
    .filter((text): text is string => typeof text === "string")
    .join("\n")
    .trim();
}

function asMessage(row: MessageRow): WorkspaceChatMessage {
  return {
    id: row.id,
    role: row.role,
    text: textContent(row.content),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** One grounded answer shared by the in-app chat and every team-chat plugin. */
export async function answerWorkspaceQuestion(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    question: string;
    baseUrl: string;
    chat: ChatCompleteCapability;
    history?: readonly ChatMessage[];
  },
): Promise<string> {
  const question = cleanQuestion(input.question);
  if (!question) return "Ask me a question about this Braino workspace.";
  const recentUserContext = (input.history ?? [])
    .filter((message) => message.role === "user")
    .slice(-3)
    .map((message) => message.content);
  const retrievalQuestion = [...recentUserContext, question].join(" ");
  let records = await searchWorkspaceRecords(
    client,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      query: retrievalQuestion,
      limit: 8,
    },
    { retrievalStore: null },
  );
  if (records.length === 0) {
    const broad = broadLexicalQuery(retrievalQuestion);
    if (broad && broad !== retrievalQuestion) {
      records = await searchWorkspaceRecords(
        client,
        { workspaceId: input.workspaceId, userId: input.userId, query: broad, limit: 8 },
        { retrievalStore: null },
      );
    }
  }
  if (records.length === 0) return "I couldn't find that in this Braino workspace.";
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const context = records.map((record) => ({
    title: record.title,
    type: record.node_type,
    excerpt: record.excerpt,
    url: `${baseUrl}/${encodeURIComponent(record.collection_handle)}/${encodeURIComponent(record.id)}`,
  }));
  const answer = await input.chat.complete({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      ...(input.history ?? []),
      {
        role: "user",
        content: `Question: ${question}\n\nWorkspace records:\n${JSON.stringify(context, null, 2)}`,
      },
    ],
  });
  return answer.content;
}

/** The signed-in person's single, workspace-scoped in-app conversation. */
export async function listWorkspaceChatMessages(
  client: PoolClient,
  input: { workspaceId: string; userId: string },
): Promise<WorkspaceChatMessage[]> {
  const found = await client.query<MessageRow>(
    `SELECT recent.id, recent.role, recent.content, recent.created_at
       FROM (
         SELECT m.id, m.role, m.content, m.created_at
           FROM chat_messages m
           JOIN chat_conversations c ON c.id = m.conversation_id
           JOIN workspace_users wu ON wu.workspace_id = c.workspace_id AND wu.user_id = c.user_id
          WHERE c.workspace_id = $1 AND c.user_id = $2 AND c.collection_id IS NULL
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3
       ) recent
      ORDER BY recent.created_at, recent.id`,
    [input.workspaceId, input.userId, MAX_HISTORY_MESSAGES],
  );
  return found.rows.map(asMessage);
}

/** Answer and persist one successful in-app turn through the canonical grounded path. */
export async function sendWorkspaceChatMessage(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    question: string;
    baseUrl: string;
    chat: ChatCompleteCapability;
  },
): Promise<{ answer: string }> {
  const question = cleanQuestion(input.question);
  if (!question) throw new Error("Type a question for Señor Braino.");
  if (question.length > 4_000) throw new Error("Questions must be 4,000 characters or fewer.");
  const messages = await listWorkspaceChatMessages(client, input);
  const answer = await answerWorkspaceQuestion(client, {
    ...input,
    question,
    history: messages.map(({ role, text }) => ({ role, content: text })),
  });
  const conversationId = `conversation_${generateUlid()}`;
  const userMessageId = `message_${generateUlid()}`;
  const assistantMessageId = `message_${generateUlid()}`;
  const title = question.split(/\s+/).slice(0, 6).join(" ").slice(0, 60);

  await client.query("BEGIN");
  try {
    const conversation = await client.query<{ id: string }>(
      `INSERT INTO chat_conversations (id, user_id, workspace_id, title)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (
          SELECT 1 FROM workspace_users WHERE workspace_id = $3 AND user_id = $2
        )
       ON CONFLICT (user_id, workspace_id)
         WHERE workspace_id IS NOT NULL AND collection_id IS NULL
       DO UPDATE SET archived = false, updated_at = now()
       RETURNING id`,
      [conversationId, input.userId, input.workspaceId, title],
    );
    const id = conversation.rows[0]?.id;
    if (!id) throw new Error("Workspace access is required.");
    await client.query(
      `INSERT INTO chat_messages (id, conversation_id, role, content) VALUES
       ($1, $3, 'user', $4::jsonb),
       ($2, $3, 'assistant', $5::jsonb)`,
      [
        userMessageId,
        assistantMessageId,
        id,
        JSON.stringify([{ type: "text", text: question }]),
        JSON.stringify([{ type: "text", text: answer }]),
      ],
    );
    await client.query("UPDATE chat_conversations SET updated_at = now() WHERE id = $1", [id]);
    await recordWorkspaceOperation(client, input.workspaceId, "reply", assistantMessageId);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return { answer };
}
