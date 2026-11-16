import type { PoolClient } from "@doco/db";
import type { ChatCompleteCapability } from "@doco/plugin-runtime";
import { searchWorkspaceRecords } from "./workspace-search.js";

const SYSTEM_PROMPT = `You are Señor Braino, the assistant for one Braino workspace.
Answer the person's question only from the workspace records supplied below.
Be direct and concise. Preserve useful record links. If the records do not support a claim, say so.`;

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

/** One grounded answer used by any team-chat provider plugin. */
export async function answerTeamChatQuestion(
  client: PoolClient,
  input: {
    workspaceId: string;
    userId: string;
    question: string;
    baseUrl: string;
    chat: ChatCompleteCapability;
  },
): Promise<string> {
  const question = cleanQuestion(input.question);
  if (!question) return "Ask me a question about this Braino workspace.";
  let records = await searchWorkspaceRecords(
    client,
    {
      workspaceId: input.workspaceId,
      userId: input.userId,
      query: question,
      limit: 8,
    },
    { retrievalStore: null },
  );
  if (records.length === 0) {
    const broad = broadLexicalQuery(question);
    if (broad && broad !== question) {
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
      {
        role: "user",
        content: `Question: ${question}\n\nWorkspace records:\n${JSON.stringify(context, null, 2)}`,
      },
    ],
  });
  return answer.content;
}
