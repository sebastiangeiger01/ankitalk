-- 0021_tts_cache_event_hash.sql
-- Add the server cache hash to TTS cache monitor rows so staging can verify whether repeated
-- requests for the same visible card text are using the same synthesis identity.
ALTER TABLE tts_cache_events ADD COLUMN hash TEXT;

CREATE INDEX IF NOT EXISTS idx_tts_cache_events_user_hash
  ON tts_cache_events(user_id, hash, created_at);
