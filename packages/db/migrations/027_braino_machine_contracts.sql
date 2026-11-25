-- Finish the product rename at every durable machine boundary. Credentials
-- include their prefix in the secret held by a client, so they are revoked
-- instead of preserving a second accepted contract.
DO $migration$
DECLARE
  legacy_name text := chr(100) || 'oco';
  legacy_workspace_column text := (chr(100) || 'oco') || '_workspace_id';
  legacy_rebrand_key text := (chr(100) || 'oco') || '_channel_rebrand_completed_at';
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'group_chat_installations'
       AND column_name = legacy_workspace_column
  ) THEN
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'group_chat_installations'
         AND column_name = 'braino_workspace_id'
    ) THEN
      EXECUTE format(
        'UPDATE group_chat_installations SET braino_workspace_id = coalesce(braino_workspace_id, %I)',
        legacy_workspace_column
      );
      EXECUTE format(
        'ALTER TABLE group_chat_installations DROP COLUMN %I',
        legacy_workspace_column
      );
    ELSE
      EXECUTE format(
        'ALTER TABLE group_chat_installations RENAME COLUMN %I TO braino_workspace_id',
        legacy_workspace_column
      );
    END IF;
  END IF;

  ALTER TABLE agent_results DROP CONSTRAINT IF EXISTS agent_results_tool_check;
  UPDATE agent_results
     SET tool = CASE tool
       WHEN legacy_name || '_brief' THEN 'braino_brief'
       WHEN legacy_name || '_search' THEN 'braino_search'
       ELSE tool
     END;
  ALTER TABLE agent_results ADD CONSTRAINT agent_results_tool_check
    CHECK (tool IN ('braino_brief', 'braino_search'));

  UPDATE group_chat_installations
     SET data = (data - legacy_rebrand_key) ||
                jsonb_build_object(
                  'braino_channel_rebrand_completed_at',
                  data->legacy_rebrand_key
                )
   WHERE data ? legacy_rebrand_key;

  UPDATE changesets
     SET metadata = jsonb_set(metadata, '{surface}', '"senor_braino"'::jsonb)
   WHERE metadata->>'surface' = 'senor_' || legacy_name;

  UPDATE hook_tokens
     SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
   WHERE token !~ '^[0-9a-f]{64}$';
  UPDATE hook_tokens SET revoked = true, token_sealed = NULL
   WHERE NOT revoked OR token_sealed IS NOT NULL;
  UPDATE incoming_webhooks SET revoked = true WHERE NOT revoked;
  DELETE FROM oauth_clients;
END
$migration$;

CREATE OR REPLACE FUNCTION braino_allow_history_delete_for_collection() RETURNS trigger AS $$
BEGIN
  PERFORM set_config('braino.allow_history_delete', 'on', true);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION braino_block_history_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting('braino.allow_history_delete', true) = 'on'
    AND pg_trigger_depth() > 1
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'history append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS collections_allow_history_delete ON collections;
CREATE TRIGGER collections_allow_history_delete
  BEFORE DELETE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION braino_allow_history_delete_for_collection();

DO $migration$
DECLARE
  table_name text;
  legacy_name text := chr(100) || 'oco';
BEGIN
  FOREACH table_name IN ARRAY ARRAY['changesets','node_versions','edge_versions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only_row ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_append_only_row BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION braino_block_history_mutation()',
      table_name,
      table_name
    );
    EXECUTE format('DROP TRIGGER IF EXISTS %I_append_only_stmt ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE TRIGGER %I_append_only_stmt BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION braino_block_history_mutation()',
      table_name,
      table_name
    );
  END LOOP;

  EXECUTE format(
    'DROP FUNCTION IF EXISTS %I()',
    legacy_name || '_allow_history_delete_for_collection'
  );
  EXECUTE format(
    'DROP FUNCTION IF EXISTS %I()',
    legacy_name || '_block_history_mutation'
  );
END
$migration$;

CREATE OR REPLACE VIEW activity_writes AS
SELECT cs.collection_id, cs.actor, cs.source, cs.metadata, cs.recorded_at AS at
FROM changesets cs
WHERE (cs.source NOT IN ('import','api')
       OR cs.metadata->>'surface' IN ('website','slack','mcp')
       OR (cs.metadata->>'surface' = 'senor_braino' AND cs.metadata->>'client' = 'website')
       OR (cs.source = 'api' AND (nullif(cs.metadata->>'auth','') IS NOT NULL
           OR nullif(trim(cs.metadata->>'token_name'),'') IS NOT NULL
           OR nullif(trim(cs.metadata->>'client_name'),'') IS NOT NULL
           OR (cs.actor IS NOT NULL AND cs.metadata->>'route' = 'changesets'))))
  AND NOT EXISTS (SELECT 1 FROM node_versions v
                  WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy');
