-- Listen feature: text-to-audio "documents" and their per-chunk "segments".

CREATE TABLE IF NOT EXISTS listen_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | generating | complete | partial | failed
  total_chars INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  tts_model TEXT NOT NULL,
  voice_id TEXT NOT NULL,
  estimated_credits REAL NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,               -- sha-256 hex of (normalized text + voice + model)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+14 days'))
);
CREATE INDEX idx_listen_documents_user ON listen_documents(user_id, created_at);
CREATE INDEX idx_listen_documents_hash ON listen_documents(user_id, content_hash);
CREATE INDEX idx_listen_documents_expires ON listen_documents(expires_at);

CREATE TABLE IF NOT EXISTS listen_segments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES listen_documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                     -- 0-based order
  source_text TEXT NOT NULL,                -- retained for future interactive Q&A
  char_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | generating | done | failed
  r2_key TEXT,                              -- listen/{userId}/{docId}/{seq}.mp3 (null until done)
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_listen_segments_doc_seq ON listen_segments(document_id, seq);
CREATE INDEX idx_listen_segments_status ON listen_segments(document_id, status);
