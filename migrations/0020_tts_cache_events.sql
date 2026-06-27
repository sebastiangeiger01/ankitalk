-- 0020_tts_cache_events.sql
-- Lightweight monitor for the TTS cache: one row per /api/tts request recording only the cache
-- outcome (edge-hit / r2-hit / miss / no-bucket) and the character count — never the card text.
-- Powers the cache panel in settings (hit rate + characters saved from the provider) and is a
-- debugging aid for the "why is ElevenLabs still being charged" investigation. Pruned to a short
-- window on read, so it never grows unbounded; safe to drop later if we retire the monitor.
CREATE TABLE IF NOT EXISTS tts_cache_events (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  chars INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tts_cache_events_user ON tts_cache_events(user_id, created_at);
