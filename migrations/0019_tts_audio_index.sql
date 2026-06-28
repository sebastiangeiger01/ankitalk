-- 0019_tts_audio_index.sql
-- Lightweight per-user index of cached TTS audio, purely so the settings page can show how much
-- voice audio is cached. The audio bytes themselves live in R2 (keyed by an opaque hash that does
-- not contain the user id), so R2 alone cannot answer "how much has THIS user cached" — this table
-- does.
--
-- Consistency without watching R2: each row carries an expires_at computed with the SAME rule R2's
-- object-lifecycle uses (delete N days after the last write, N = std/pin window). The app bumps
-- expires_at exactly when it re-writes the object, so a row is "live" iff the R2 object still
-- exists. Stats queries count only rows with expires_at > now; expired rows are swept opportunistically.
CREATE TABLE IF NOT EXISTS tts_audio (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,   -- 1 = stored under the long-retention exam-pin prefix
  expires_at TEXT NOT NULL,            -- mirrors the R2 lifecycle deletion clock
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, hash)
);

CREATE INDEX IF NOT EXISTS idx_tts_audio_user_exp ON tts_audio(user_id, expires_at);
