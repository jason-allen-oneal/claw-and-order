-- Durable, coalescing review queue. A revision prevents stale analysis commits.
CREATE SEQUENCE IF NOT EXISTS review_revision;
CREATE TABLE IF NOT EXISTS review_jobs (
  guild_id text NOT NULL,
  author_id text NOT NULL,
  revision bigint NOT NULL DEFAULT nextval('review_revision'),
  dirty boolean NOT NULL DEFAULT true,
  due_at timestamptz NOT NULL DEFAULT now(),
  touched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, author_id)
);
CREATE INDEX IF NOT EXISTS review_jobs_due ON review_jobs(guild_id, due_at) WHERE dirty;
CREATE TABLE IF NOT EXISTS moderation_cases (
  id bigserial PRIMARY KEY,
  guild_id text NOT NULL,
  author_id text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','dismissed','inconclusive','confirmed-automation')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  priority text NOT NULL,
  score integer CHECK (score BETWEEN 0 AND 100),
  detector_version text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_case ON moderation_cases(guild_id, author_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS cases_member ON moderation_cases(guild_id, author_id, created_at DESC);
-- The case and its notification are committed together. No raw content here.
CREATE TABLE IF NOT EXISTS case_outbox (
  case_id bigint PRIMARY KEY REFERENCES moderation_cases(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),
  message_id text,
  delivered_at timestamptz
);
