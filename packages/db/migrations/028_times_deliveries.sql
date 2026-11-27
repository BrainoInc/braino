-- A published Times edition is delivered once to each transport destination.
-- Failed attempts remain retryable; successful external receipts make every
-- later scheduler tick a no-op for that destination.
CREATE TABLE IF NOT EXISTS times_deliveries (
  workspace_id text NOT NULL,
  cadence      text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  edition_day  date NOT NULL,
  transport    text NOT NULL CHECK (transport IN ('email', 'team_chat')),
  recipient    text NOT NULL CHECK (recipient <> ''),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  attempted_at timestamptz,
  delivered_at timestamptz,
  external_id  text,
  last_error   text,
  PRIMARY KEY (workspace_id, cadence, edition_day, transport, recipient)
);

ALTER TABLE times_deliveries
  ADD CONSTRAINT times_deliveries_edition_fk
  FOREIGN KEY (workspace_id, cadence, edition_day)
  REFERENCES times_editions(workspace_id, cadence, edition_day) ON DELETE CASCADE;

