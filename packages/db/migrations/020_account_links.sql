CREATE TABLE IF NOT EXISTS account_links (
  id                 text PRIMARY KEY,
  token_hash         text NOT NULL UNIQUE,
  kind               text NOT NULL CHECK (kind IN ('workspace_invitation', 'password_reset')),
  workspace_id       text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email              text NOT NULL,
  user_id            text REFERENCES users(id) ON DELETE CASCADE,
  role               text CHECK (role IN ('owner', 'writer', 'reader')),
  write_types        text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  revoked_at         timestamptz,
  CHECK (
    (kind = 'workspace_invitation' AND user_id IS NULL AND role IS NOT NULL) OR
    (kind = 'password_reset' AND user_id IS NOT NULL AND role IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS account_links_pending_workspace_idx
  ON account_links (workspace_id, kind, created_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
