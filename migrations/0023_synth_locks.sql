-- Generation locks, moved off Workers KV.
--
-- Both TTS paths took a KV lock per clip to stop two isolates paying the provider twice for
-- the same audio: one put on acquire, one delete on release. Workers KV's free tier allows
-- 1,000 writes and 1,000 deletes per day for the whole account, so a single long listen
-- document — one lock per sentence — could exhaust it, after which every KV-backed feature
-- (including the rate limiter) starts failing.
--
-- D1 is both roomier and more correct here: an INSERT against a primary key is atomic, so this
-- is a real compare-and-set rather than the read-then-write race KV could only narrow.
CREATE TABLE IF NOT EXISTS synth_locks (
	-- Namespaced by caller, e.g. 'listen:<user>:<hash>' or 'tts:<hash>'.
	lock_key TEXT PRIMARY KEY,
	expires_at TEXT NOT NULL
);

-- Supports reclaiming locks abandoned by a crashed generator.
CREATE INDEX IF NOT EXISTS idx_synth_locks_expires ON synth_locks(expires_at);
