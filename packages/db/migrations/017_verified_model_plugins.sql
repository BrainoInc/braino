-- A configured model plugin is not usable until the host has exercised its
-- capability successfully. Configuration or artifact changes clear this mark;
-- the setup flow restores it only after both required models answer.
ALTER TABLE plugin_installations
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_embedding_dimensions integer
    CHECK (verified_embedding_dimensions > 0);
