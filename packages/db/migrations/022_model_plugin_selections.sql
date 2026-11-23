-- A workspace may keep several model plugins installed, but Braino routes each
-- required model capability through exactly one explicitly selected plugin.
CREATE UNIQUE INDEX IF NOT EXISTS plugin_installations_workspace_id_idx
  ON plugin_installations (workspace_id, id);

CREATE TABLE IF NOT EXISTS workspace_model_plugin_selections (
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  capability         text NOT NULL
                       CHECK (capability IN ('chat.complete', 'embedding.embed')),
  installation_id    text NOT NULL,
  updated_by_user_id text NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, capability),
  FOREIGN KEY (workspace_id, installation_id)
    REFERENCES plugin_installations(workspace_id, id)
);
CREATE INDEX IF NOT EXISTS workspace_model_plugin_selections_installation_idx
  ON workspace_model_plugin_selections (installation_id);

-- Preserve the provider selected by the previous one-enabled-provider model.
WITH candidates AS (
  SELECT i.workspace_id,
         capability.name AS capability,
         i.id AS installation_id,
         i.updated_by_user_id,
         i.created_at,
         i.updated_at,
         row_number() OVER (
           PARTITION BY i.workspace_id, capability.name
           ORDER BY i.updated_at DESC, i.id
         ) AS preference
    FROM plugin_installations i
    CROSS JOIN LATERAL (
      VALUES ('chat.complete'), ('embedding.embed')
    ) AS capability(name)
   WHERE i.enabled AND i.manifest->'capabilities' ? capability.name
)
INSERT INTO workspace_model_plugin_selections
  (workspace_id, capability, installation_id, updated_by_user_id, created_at, updated_at)
SELECT workspace_id, capability, installation_id, updated_by_user_id, created_at, updated_at
  FROM candidates
 WHERE preference = 1
ON CONFLICT (workspace_id, capability) DO NOTHING;

-- Model-plugin installation is now independent from selection.
UPDATE plugin_installations
   SET enabled = true
 WHERE manifest->'capabilities' ? 'chat.complete'
    OR manifest->'capabilities' ? 'embedding.embed';
