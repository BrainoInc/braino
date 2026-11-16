ALTER TABLE github_connections
  ALTER COLUMN token_sealed DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS plugin_installation_id text
    REFERENCES plugin_installations(id),
  ADD COLUMN IF NOT EXISTS require_braino boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS github_connections_plugin_installation_idx
  ON github_connections (plugin_installation_id)
  WHERE plugin_installation_id IS NOT NULL;
