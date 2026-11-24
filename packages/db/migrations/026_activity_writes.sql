-- Human and agent writes used by the usage report, activity feed and Times.
CREATE OR REPLACE VIEW activity_writes AS
SELECT cs.collection_id, cs.actor, cs.source, cs.metadata, cs.recorded_at AS at
FROM changesets cs
WHERE (cs.source NOT IN ('import','api')
       OR cs.metadata->>'surface' IN ('website','slack','mcp')
       OR (cs.metadata->>'surface' = 'senor_doco' AND cs.metadata->>'client' = 'website')
       OR (cs.source = 'api' AND (nullif(cs.metadata->>'auth','') IS NOT NULL
           OR nullif(trim(cs.metadata->>'token_name'),'') IS NOT NULL
           OR nullif(trim(cs.metadata->>'client_name'),'') IS NOT NULL
           OR (cs.actor IS NOT NULL AND cs.metadata->>'route' = 'changesets'))))
  AND NOT EXISTS (SELECT 1 FROM node_versions v
                  WHERE v.tx_id = cs.tx_id AND v.entity_type = 'policy');
