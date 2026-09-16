CREATE TABLE IF NOT EXISTS observations (
  guild_id text NOT NULL,
  message_id text NOT NULL,
  author_id text NOT NULL,
  channel_id text NOT NULL,
  created_at timestamptz NOT NULL,
  reply_to_id text,
  content_length integer CHECK (content_length >= 0),
  fingerprint text,
  artifacts jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (guild_id, message_id)
);
CREATE INDEX IF NOT EXISTS observations_subject_window ON observations(guild_id, author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS observations_retention ON observations(created_at);
-- Tombstones contain IDs only, expire with retention, and block replay after removal.
CREATE TABLE IF NOT EXISTS removed_messages (
  guild_id text NOT NULL,
  message_id text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, message_id)
);
