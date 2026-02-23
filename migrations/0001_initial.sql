-- AnkiTalk D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  hanko_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anki_id INTEGER,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  card_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_decks_user ON decks(user_id);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  anki_id INTEGER,
  model_name TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]', -- JSON array of {name, value} objects
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_notes_deck ON notes(deck_id);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  anki_id INTEGER,
  ordinal INTEGER NOT NULL DEFAULT 0,
  card_type TEXT NOT NULL DEFAULT 'basic', -- basic, cloze
  due_at TEXT NOT NULL DEFAULT (datetime('now')),
  fsrs_state INTEGER NOT NULL DEFAULT 0,
  fsrs_stability REAL NOT NULL DEFAULT 0,
  fsrs_difficulty REAL NOT NULL DEFAULT 0,
  fsrs_elapsed_days INTEGER NOT NULL DEFAULT 0,
  fsrs_scheduled_days INTEGER NOT NULL DEFAULT 0,
  fsrs_reps INTEGER NOT NULL DEFAULT 0,
  fsrs_lapses INTEGER NOT NULL DEFAULT 0,
  fsrs_last_review TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_cards_deck ON cards(deck_id);
CREATE INDEX idx_cards_note ON cards(note_id);
CREATE INDEX idx_cards_due ON cards(deck_id, due_at);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  rating TEXT NOT NULL, -- again, hard, good, easy
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_reviews_card ON reviews(card_id);
CREATE INDEX idx_reviews_deck_date ON reviews(deck_id, created_at);
