-- Only authenticated writes set this transaction-local identity. Imports and
-- pre-migration events retain their workspace-wide attribution.
ALTER TABLE workspace_operations ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspace_content_usage ADD COLUMN IF NOT EXISTS user_id text REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS workspace_operations_member_time_idx ON workspace_operations(workspace_id, user_id, at) WHERE user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION attribute_content_usage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT user_id INTO NEW.user_id FROM workspace_users
   WHERE workspace_id = NEW.workspace_id AND user_id = current_setting('braino.usage_user_id', true);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS attribute_content_usage ON workspace_content_usage;
CREATE TRIGGER attribute_content_usage BEFORE INSERT ON workspace_content_usage FOR EACH ROW
  WHEN (NEW.ingested_tokens > 0 AND nullif(current_setting('braino.usage_user_id', true), '') IS NOT NULL)
  EXECUTE FUNCTION attribute_content_usage();
