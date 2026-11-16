CREATE TABLE IF NOT EXISTS github_app_registrations (
  workspace_id            text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id                  bigint NOT NULL UNIQUE CHECK (app_id > 0),
  slug                    text NOT NULL CHECK (slug <> ''),
  html_url                text NOT NULL CHECK (html_url <> ''),
  client_id               text NOT NULL CHECK (client_id <> ''),
  private_key_sealed      text NOT NULL,
  webhook_secret_sealed   text NOT NULL,
  created_by_user_id      text NOT NULL REFERENCES users(id),
  updated_by_user_id      text NOT NULL REFERENCES users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE github_connections
  ADD COLUMN IF NOT EXISTS installation_id bigint,
  ADD COLUMN IF NOT EXISTS require_braino boolean NOT NULL DEFAULT false;

-- The App installation is the only GitHub credential and its global signed
-- webhook is the only delivery path. Existing PAT connections remain visible
-- but inactive until their owner installs the App on the same repository.
UPDATE github_connections
   SET active = false, sync_token = NULL, sync_started_at = NULL
 WHERE installation_id IS NULL;

ALTER TABLE github_connections
  DROP COLUMN IF EXISTS token_sealed,
  DROP COLUMN IF EXISTS webhook_id,
  DROP COLUMN IF EXISTS webhook_secret_sealed,
  DROP COLUMN IF EXISTS webhook_url,
  DROP COLUMN IF EXISTS webhook_created_at;
