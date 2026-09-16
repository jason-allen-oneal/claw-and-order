-- Derived local semantic result; raw message content is never stored.
ALTER TABLE observations ADD COLUMN IF NOT EXISTS semantic jsonb;
