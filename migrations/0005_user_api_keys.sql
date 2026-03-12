CREATE TABLE user_api_keys (
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,          -- 'openai' | 'deepgram' | 'anthropic'
  encrypted_key TEXT NOT NULL,    -- base64(iv + ciphertext + tag)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, service),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  service TEXT NOT NULL,           -- 'openai' | 'deepgram' | 'anthropic'
  operation TEXT NOT NULL,         -- 'tts' | 'stt_token' | 'explain'
  units INTEGER NOT NULL,          -- characters (TTS), seconds (STT), tokens (Anthropic)
  estimated_cost_usd REAL NOT NULL,-- calculated cost in USD
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_api_usage_user_date ON api_usage(user_id, created_at);
