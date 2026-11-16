-- Inbound plugin events are acknowledged only after they are durably queued.
-- The installation foreign key is the workspace/provider boundary; the
-- provider's external id makes retries idempotent.
CREATE TABLE IF NOT EXISTS plugin_event_deliveries (
  id              text PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  installation_id text NOT NULL REFERENCES plugin_installations(id) ON DELETE CASCADE,
  actor_user_id    text REFERENCES users(id) ON DELETE SET NULL,
  external_id     text NOT NULL,
  kind            text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at    timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  processed_at    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (installation_id, external_id)
);

CREATE INDEX IF NOT EXISTS plugin_event_deliveries_pending_idx
  ON plugin_event_deliveries (available_at, created_at)
  WHERE processed_at IS NULL;
