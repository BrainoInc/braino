import { withClient } from "@doco/db";
import {
  answerTeamChatQuestion,
  getSingleWorkspaceState,
  processNextTeamChatEvent,
  publishDueTimesEdition,
  resolveWorkspaceChatProvider,
  resolveWorkspaceEmbeddingProvider,
  resolveWorkspaceTeamChatPlugin,
} from "@doco/host";
import { syncQueuedEmbeddings, syncRetrievalSourceBatch } from "@doco/index";
import { QdrantVectorStore } from "@doco/index/qdrant-vector-store";

const pollMs = Number(process.env.BRAINO_TIMES_POLL_MS ?? 60_000);
if (!Number.isFinite(pollMs) || pollMs < 1_000) {
  throw new Error("BRAINO_TIMES_POLL_MS must be at least 1000 milliseconds.");
}
const teamChatPollMs = Number(process.env.BRAINO_TEAM_CHAT_POLL_MS ?? 1_000);
if (!Number.isFinite(teamChatPollMs) || teamChatPollMs < 250) {
  throw new Error("BRAINO_TEAM_CHAT_POLL_MS must be at least 250 milliseconds.");
}

const baseUrl = (process.env.DOCO_PUBLIC_HOST ?? "http://localhost:3000").replace(/\/+$/, "");
let publishing = false;
let indexing = false;
let answeringTeamChat = false;

async function publish() {
  if (publishing) return;
  publishing = true;
  try {
    const state = await withClient(getSingleWorkspaceState);
    if (!state.initialized) return;
    const edition = await withClient((client) =>
      publishDueTimesEdition(client, {
        workspaceId: state.workspace.id,
        at: new Date(),
        baseUrl,
      }),
    );
    if (edition)
      console.log(`[times] published ${edition.day} with ${edition.stories.length} stories`);
  } catch (error) {
    console.error("[times] publication failed", error);
  } finally {
    publishing = false;
  }
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function qdrantStore() {
  const url = process.env.QDRANT_URL?.trim();
  if (!url) return null;
  const apiKey = process.env.QDRANT_API_KEY?.trim();
  return new QdrantVectorStore({
    url,
    ...(apiKey ? { apiKey } : {}),
    collection: "doco_embeddings",
    dimensions: 1536,
    timeoutMs: 15_000,
  });
}

const vectorStore = qdrantStore();

async function indexRetrieval() {
  if (indexing || !vectorStore) return;
  indexing = true;
  try {
    const state = await withClient(getSingleWorkspaceState);
    if (!state.initialized) return;
    const report = await withClient(async (client) => {
      const provider = await resolveWorkspaceEmbeddingProvider(client, {
        workspaceId: state.workspace.id,
        encryptionKey: required("DOCO_ENCRYPTION_KEY"),
        host: {
          url: required("BRAINO_PLUGIN_HOST_URL"),
          apiToken: required("BRAINO_PLUGIN_HOST_API_TOKEN"),
        },
      });
      if (!provider) return null;

      let indexed = 0;
      for (let batch = 0; batch < 10; batch++) {
        const current = await syncRetrievalSourceBatch(client, {
          embeddingProvider: provider,
          limit: 50,
        });
        indexed += current.indexed;
        if (current.exhausted) break;
      }

      let projected = 0;
      for (let batch = 0; batch < 10; batch++) {
        const current = await syncQueuedEmbeddings(client, vectorStore, { batchSize: 256 });
        projected += current.processed;
        if (current.exhausted) break;
      }
      return { indexed, projected, modelId: provider.modelId };
    });
    if (report && (report.indexed > 0 || report.projected > 0)) {
      console.log(
        `[retrieval] indexed ${report.indexed}, projected ${report.projected} with ${report.modelId}`,
      );
    }
  } catch (error) {
    console.error("[retrieval] indexing failed", error);
  } finally {
    indexing = false;
  }
}

async function drainTeamChat() {
  if (answeringTeamChat) return;
  answeringTeamChat = true;
  try {
    const state = await withClient(getSingleWorkspaceState);
    if (!state.initialized) return;
    await withClient(async (client) => {
      const connection = {
        workspaceId: state.workspace.id,
        encryptionKey: required("DOCO_ENCRYPTION_KEY"),
        host: {
          url: required("BRAINO_PLUGIN_HOST_URL"),
          apiToken: required("BRAINO_PLUGIN_HOST_API_TOKEN"),
        },
      };
      const [chat, teamChat] = await Promise.all([
        resolveWorkspaceChatProvider(client, connection),
        resolveWorkspaceTeamChatPlugin(client, connection),
      ]);
      if (!chat || !teamChat) return;

      for (let count = 0; count < 10; count++) {
        const result = await processNextTeamChatEvent(client, {
          answer: ({ workspaceId, userId, question }) =>
            answerTeamChatQuestion(client, {
              workspaceId,
              userId,
              question,
              baseUrl,
              chat,
            }),
          send: ({ installationId, message }) => {
            if (installationId !== teamChat.installation.installationId) {
              throw new Error("The team-chat installation changed while processing an event.");
            }
            return teamChat.send(message);
          },
        });
        if (result === "empty") break;
      }
    });
  } catch (error) {
    console.error("[team-chat] event processing failed", error);
  } finally {
    answeringTeamChat = false;
  }
}

await publish();
await indexRetrieval();
await drainTeamChat();
const timesInterval = setInterval(publish, pollMs);
const retrievalInterval = setInterval(
  indexRetrieval,
  Number(process.env.BRAINO_RETRIEVAL_POLL_MS ?? 60_000),
);
const teamChatInterval = setInterval(drainTeamChat, teamChatPollMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    clearInterval(timesInterval);
    clearInterval(retrievalInterval);
    clearInterval(teamChatInterval);
    process.exit(0);
  });
}
