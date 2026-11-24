-- Usage is scoped to the workspace. Source text is measured before chunking or
-- embedding. A retained text revision contributes its full estimated input once.
CREATE TABLE IF NOT EXISTS workspace_operations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('query','reply')),
  operation_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (workspace_id, kind, operation_id)
);
CREATE INDEX IF NOT EXISTS workspace_operations_time_idx ON workspace_operations (workspace_id, at);

CREATE TABLE IF NOT EXISTS workspace_content_usage (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Keeps attribution after a collection and its source rows are deleted.
  collection_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ingested_tokens bigint NOT NULL CHECK (ingested_tokens >= 0),
  byte_delta bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_content_usage_time_idx ON workspace_content_usage (workspace_id, at);
CREATE INDEX IF NOT EXISTS workspace_content_usage_collection_idx ON workspace_content_usage (collection_id, workspace_id);

-- One definition of the retained body per source, used for inserts, edits,
-- moves and deletes. PostgreSQL rolls usage back with the source write.
CREATE OR REPLACE FUNCTION meter_source_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_text text;
  after_text text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    CASE TG_TABLE_NAME
      WHEN 'nodes' THEN before_text := OLD.prose;
      WHEN 'code_files' THEN before_text := OLD.content;
      WHEN 'notion_pages' THEN before_text := OLD.markdown;
      WHEN 'google_drive_files' THEN before_text := OLD.markdown;
      WHEN 'group_chat_messages' THEN before_text := OLD.text;
    END CASE;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    CASE TG_TABLE_NAME
      WHEN 'nodes' THEN after_text := NEW.prose;
      WHEN 'code_files' THEN after_text := NEW.content;
      WHEN 'notion_pages' THEN after_text := NEW.markdown;
      WHEN 'google_drive_files' THEN after_text := NEW.markdown;
      WHEN 'group_chat_messages' THEN after_text := NEW.text;
    END CASE;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.collection_id = NEW.collection_id THEN
    IF before_text IS DISTINCT FROM after_text THEN
      INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
      SELECT workspace_id, id, (length(after_text)::bigint + 3) / 4,
             octet_length(after_text)::bigint - octet_length(before_text)
        FROM collections WHERE id = NEW.collection_id;
    END IF;
    RETURN NULL;
  END IF;
  IF coalesce(before_text, '') <> '' THEN
    INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
    SELECT workspace_id, id, 0, -octet_length(before_text)::bigint
      FROM collections WHERE id = OLD.collection_id;
  END IF;
  IF coalesce(after_text, '') <> '' THEN
    INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
    SELECT workspace_id, id, (length(after_text)::bigint + 3) / 4, octet_length(after_text)
      FROM collections WHERE id = NEW.collection_id;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER meter_source_text AFTER INSERT OR UPDATE OF prose, collection_id OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION meter_source_text();
CREATE OR REPLACE TRIGGER meter_source_text AFTER INSERT OR UPDATE OF content, collection_id OR DELETE ON code_files
  FOR EACH ROW EXECUTE FUNCTION meter_source_text();
CREATE OR REPLACE TRIGGER meter_source_text AFTER INSERT OR UPDATE OF markdown, collection_id OR DELETE ON notion_pages
  FOR EACH ROW EXECUTE FUNCTION meter_source_text();
CREATE OR REPLACE TRIGGER meter_source_text AFTER INSERT OR UPDATE OF markdown, collection_id OR DELETE ON google_drive_files
  FOR EACH ROW EXECUTE FUNCTION meter_source_text();
CREATE OR REPLACE TRIGGER meter_source_text AFTER INSERT OR UPDATE OF text, collection_id OR DELETE ON group_chat_messages
  FOR EACH ROW EXECUTE FUNCTION meter_source_text();

-- In a cascading collection delete the parent is already gone by the time
-- its source triggers run. Settle its retained balance exactly once.
CREATE OR REPLACE FUNCTION move_collection_usage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  retained bigint;
BEGIN
  SELECT sum(byte_delta) INTO retained FROM workspace_content_usage
    WHERE collection_id = OLD.id AND workspace_id = OLD.workspace_id;
  IF coalesce(retained, 0) <> 0 THEN
    INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
    SELECT id, OLD.id, 0, -retained FROM workspaces WHERE id = OLD.workspace_id;
    IF TG_OP = 'UPDATE' THEN
      INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
      VALUES (NEW.workspace_id, NEW.id, 0, retained);
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER meter_collection_delete AFTER DELETE ON collections
  FOR EACH ROW EXECUTE FUNCTION move_collection_usage();
CREATE OR REPLACE TRIGGER meter_collection_move AFTER UPDATE OF workspace_id ON collections
  FOR EACH ROW WHEN (OLD.workspace_id <> NEW.workspace_id) EXECUTE FUNCTION move_collection_usage();

-- Open with the size already retained, without counting a deployment as ingestion.
INSERT INTO workspace_content_usage (workspace_id, collection_id, ingested_tokens, byte_delta)
SELECT c.workspace_id, c.id, 0, sum(s.bytes)
FROM (
  SELECT collection_id, sum(octet_length(prose)) AS bytes FROM nodes GROUP BY collection_id
  UNION ALL
  SELECT collection_id, sum(octet_length(content)) AS bytes FROM code_files GROUP BY collection_id
  UNION ALL
  SELECT collection_id, sum(octet_length(markdown)) AS bytes FROM notion_pages GROUP BY collection_id
  UNION ALL
  SELECT collection_id, sum(octet_length(markdown)) AS bytes FROM google_drive_files GROUP BY collection_id
  UNION ALL
  SELECT collection_id, sum(octet_length(text)) AS bytes FROM group_chat_messages GROUP BY collection_id
) s JOIN collections c ON c.id = s.collection_id
GROUP BY c.workspace_id, c.id HAVING sum(s.bytes) > 0;
