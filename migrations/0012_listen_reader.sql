-- Reader-first Listen v2: per-sentence cache shared across documents, original text retained.
--
-- The new model splits each document into "sentences" (TTS units, typically one or two real
-- sentences). Each sentence is hashed over its text plus voice/model/language; the audio
-- bytes live in R2 under a content-hash key shared across all documents of the same user,
-- so a sentence the user has heard once is free to re-hear within the 14 day window.
--
-- Legacy `listen_segments` table stays for backwards compatibility with existing rows; the
-- new code path doesn't write to it.

ALTER TABLE listen_documents ADD COLUMN original_text TEXT;

CREATE TABLE IF NOT EXISTS listen_sentences (
  doc_id TEXT NOT NULL REFERENCES listen_documents(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  sentence_hash TEXT NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
CREATE INDEX idx_listen_sentences_hash ON listen_sentences(sentence_hash);

CREATE TABLE IF NOT EXISTS listen_sentence_cache (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sentence_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  char_count INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL DEFAULT (datetime('now', '+14 days')),
  PRIMARY KEY (user_id, sentence_hash)
);
CREATE INDEX idx_listen_sentence_cache_expires ON listen_sentence_cache(expires_at);
