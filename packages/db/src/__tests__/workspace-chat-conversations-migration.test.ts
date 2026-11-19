import { readFile } from "node:fs/promises";
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDb } from "./fresh-db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDb();
});

describe("workspace chat conversation migration", () => {
  it("preserves history while consolidating each person's workspace chats", async () => {
    await db.exec(`
      DROP INDEX idx_chat_conversations_user_workspace;
      INSERT INTO workspaces (id, handle, name)
      VALUES ('workspace_chat', 'chat', 'Chat');
      INSERT INTO users (id, username, name, email, data)
      VALUES ('user_chat', 'chat-user', 'Chat User', 'chat@example.com', '{}');
      INSERT INTO chat_conversations
        (id, user_id, workspace_id, title, created_at, updated_at)
      VALUES
        ('conversation_old', 'user_chat', 'workspace_chat', 'Old',
         '2026-11-18T10:00:00Z', '2026-11-18T10:00:00Z'),
        ('conversation_current', 'user_chat', 'workspace_chat', 'Current',
         '2026-11-19T10:00:00Z', '2026-11-19T10:00:00Z');
      INSERT INTO chat_messages (id, conversation_id, role, content, created_at)
      VALUES
        ('message_old', 'conversation_old', 'user', '{"text":"Earlier question"}',
         '2026-11-18T10:00:00Z'),
        ('message_current', 'conversation_current', 'assistant', '{"text":"Current answer"}',
         '2026-11-19T10:00:00Z');
      INSERT INTO agent_turn_metrics (id, conversation_id, user_id, model, total_ms)
      VALUES ('metric_old', 'conversation_old', 'user_chat', 'test', 10);
    `);

    const migration = await readFile(
      new URL("../../migrations/021_workspace_chat_conversations.sql", import.meta.url),
      "utf8",
    );
    await db.exec(migration);

    const conversations = await db.query<{ id: string }>(
      "SELECT id FROM chat_conversations WHERE workspace_id = 'workspace_chat'",
    );
    expect(conversations.rows).toEqual([{ id: "conversation_current" }]);

    const messages = await db.query<{ id: string; conversation_id: string }>(
      "SELECT id, conversation_id FROM chat_messages ORDER BY created_at",
    );
    expect(messages.rows).toEqual([
      { id: "message_old", conversation_id: "conversation_current" },
      { id: "message_current", conversation_id: "conversation_current" },
    ]);

    const metrics = await db.query<{ conversation_id: string }>(
      "SELECT conversation_id FROM agent_turn_metrics WHERE id = 'metric_old'",
    );
    expect(metrics.rows).toEqual([{ conversation_id: "conversation_current" }]);

    await expect(
      db.query(
        `INSERT INTO chat_conversations (id, user_id, workspace_id)
         VALUES ('conversation_duplicate', 'user_chat', 'workspace_chat')`,
      ),
    ).rejects.toThrow();
  });
});
