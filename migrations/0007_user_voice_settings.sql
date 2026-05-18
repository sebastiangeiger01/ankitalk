CREATE TABLE IF NOT EXISTS user_voice_settings (
  user_id TEXT PRIMARY KEY,
  voice_provider TEXT NOT NULL DEFAULT 'elevenlabs',
  elevenlabs_voice_id TEXT NOT NULL DEFAULT 'JBFqnCBsd6RMkjVDRZzb',
  elevenlabs_tts_model TEXT NOT NULL DEFAULT 'eleven_flash_v2_5',
  elevenlabs_stt_model TEXT NOT NULL DEFAULT 'scribe_v2_realtime',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
