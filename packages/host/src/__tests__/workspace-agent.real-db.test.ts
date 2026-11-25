import type { PoolClient } from "@braino/db";
import type { ChatCompleteCapability } from "@braino/plugin-runtime";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDb } from "../../../db/src/__tests__/fresh-db.js";
import { initializeSingleWorkspace } from "../single-workspace.js";
import {
  answerWorkspaceQuestion,
  listWorkspaceChatMessages,
  sendWorkspaceChatMessage,
} from "../workspace-agent.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

const client = () => db as unknown as PoolClient;

async function fixture() {
  const setup = await initializeSingleWorkspace(client(), {
    workspaceHandle: "acme",
    workspaceName: "Acme",
    ownerEmail: "owner@example.com",
    ownerUsername: "owner",
    ownerName: "Acme Owner",
    ownerPasswordHash: "scrypt$salt$key",
  });
  await db.exec(`
    INSERT INTO collections (id, workspace_id, owner_id, handle, visibility, data)
    VALUES ('collection_decisions', '${setup.workspace.id}', '${setup.workspace.id}', 'decisions', 'private', '{}');
    INSERT INTO nodes (id, collection_id, node_type, lifecycle, prose, extra, created_by)
    VALUES (
      'decision_model_setup', 'collection_decisions', 'Decision', 'active',
      'The release moved live model checks into the required setup step.',
      '{"title":"Verify models before workspace entry"}', '${setup.owner.id}'
    );
  `);
  return setup;
}

describe("Señor Braino workspace answer", () => {
  it("answers through the assigned chat contract using workspace-grounded links", async () => {
    const setup = await fixture();
    const complete = vi.fn(async () => ({
      content: "Model plugins are now tested before the dashboard opens.",
      model: "test:model",
    }));
    const chat: ChatCompleteCapability = { complete };

    await expect(
      answerWorkspaceQuestion(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        question: "<@U-BOT> where did we move the model checks?",
        baseUrl: "https://braino.example",
        chat,
      }),
    ).resolves.toBe("Model plugins are now tested before the dashboard opens.");

    expect(complete).toHaveBeenCalledOnce();
    const request = complete.mock.calls[0]?.[0];
    expect(request?.messages).toHaveLength(2);
    expect(request?.messages[0]?.content).toContain("You are Señor Braino");
    expect(request?.messages[1]?.content).toContain("where did we move the model checks?");
    expect(request?.messages[1]?.content).not.toContain("<@U-BOT>");
    expect(request?.messages[1]?.content).toContain(
      "https://braino.example/decisions/decision_model_setup",
    );
    expect(request?.messages[1]?.content).toContain(
      "The release moved live model checks into the required setup step.",
    );
  });

  it("does not ask the model to invent an answer when the workspace has no matching record", async () => {
    const setup = await fixture();
    const complete = vi.fn();

    await expect(
      answerWorkspaceQuestion(client(), {
        workspaceId: setup.workspace.id,
        userId: setup.owner.id,
        question: "What is the launch code for Mars?",
        baseUrl: "https://braino.example",
        chat: { complete } as unknown as ChatCompleteCapability,
      }),
    ).resolves.toBe("I couldn't find that in this Braino workspace.");
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps one in-app conversation per person and replays its history", async () => {
    const setup = await fixture();
    const complete = vi
      .fn()
      .mockResolvedValueOnce({ content: "The checks moved into setup.", model: "test:model" })
      .mockResolvedValueOnce({ content: "Before the dashboard opens.", model: "test:model" });
    const chat: ChatCompleteCapability = { complete };

    await sendWorkspaceChatMessage(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      question: "Where did model checks move?",
      baseUrl: "https://braino.example",
      chat,
    });
    await sendWorkspaceChatMessage(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
      question: "When do they run?",
      baseUrl: "https://braino.example",
      chat,
    });

    expect((await db.query("SELECT kind FROM workspace_operations ORDER BY at")).rows).toEqual([
      { kind: "reply" },
      { kind: "reply" },
    ]);
    const messages = await listWorkspaceChatMessages(client(), {
      workspaceId: setup.workspace.id,
      userId: setup.owner.id,
    });
    expect(messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "Where did model checks move?" },
      { role: "assistant", text: "The checks moved into setup." },
      { role: "user", text: "When do they run?" },
      { role: "assistant", text: "Before the dashboard opens." },
    ]);
    expect(
      await db.query(
        "SELECT count(*)::int AS count FROM chat_conversations WHERE user_id = $1 AND workspace_id = $2",
        [setup.owner.id, setup.workspace.id],
      ),
    ).toMatchObject({ rows: [{ count: 1 }] });
    expect(complete.mock.calls[1]?.[0].messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "Where did model checks move?" },
        { role: "assistant", content: "The checks moved into setup." },
      ]),
    );
  });
});
