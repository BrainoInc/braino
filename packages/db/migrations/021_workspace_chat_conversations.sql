WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY user_id, workspace_id
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS keeper_id
    FROM chat_conversations
   WHERE workspace_id IS NOT NULL AND collection_id IS NULL
)
UPDATE chat_messages m
   SET conversation_id = ranked.keeper_id
  FROM ranked
 WHERE m.conversation_id = ranked.id
   AND ranked.id <> ranked.keeper_id;

WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY user_id, workspace_id
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS keeper_id
    FROM chat_conversations
   WHERE workspace_id IS NOT NULL AND collection_id IS NULL
)
UPDATE agent_turn_metrics m
   SET conversation_id = ranked.keeper_id
  FROM ranked
 WHERE m.conversation_id = ranked.id
   AND ranked.id <> ranked.keeper_id;

WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY user_id, workspace_id
           ORDER BY updated_at DESC, created_at DESC, id DESC
         ) AS keeper_id
    FROM chat_conversations
   WHERE workspace_id IS NOT NULL AND collection_id IS NULL
)
DELETE FROM chat_conversations c
 USING ranked
 WHERE c.id = ranked.id
   AND ranked.id <> ranked.keeper_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_user_workspace
  ON chat_conversations (user_id, workspace_id)
  WHERE workspace_id IS NOT NULL AND collection_id IS NULL;
