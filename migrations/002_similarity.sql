-- Additive upgrade: old feature-only observations remain readable with NULL sketches.
-- Keyed sketches are sensitive derived data and follow observation erasure/retention.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS similarity jsonb;
