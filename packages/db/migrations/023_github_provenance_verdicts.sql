ALTER TABLE github_connections
  DROP COLUMN IF EXISTS require_braino;

-- The first readable Braino verdict for a pull request is permanent. GitHub's
-- ruleset decides whether the check blocks merging; this row records only the
-- provenance fact and the one-time review or brief side effect.
CREATE TABLE IF NOT EXISTS github_pull_request_verdicts (
  connection_id       text NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  pull_number          bigint NOT NULL CHECK (pull_number > 0),
  went_through_braino  boolean NOT NULL,
  review_status        text CHECK (review_status IN ('processing', 'completed')),
  review_started_at    timestamptz,
  review_id            bigint,
  brief_id             text,
  brief_status         text CHECK (brief_status IN ('processing', 'completed')),
  brief_started_at     timestamptz,
  brief_comment_id     bigint,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connection_id, pull_number)
);
