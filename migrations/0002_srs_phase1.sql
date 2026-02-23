-- SRS Phase 1: deck_settings, sibling burying

CREATE TABLE IF NOT EXISTS deck_settings (
  deck_id TEXT PRIMARY KEY REFERENCES decks(id) ON DELETE CASCADE,
  new_cards_per_day INTEGER NOT NULL DEFAULT 20,
  max_reviews_per_day INTEGER NOT NULL DEFAULT 200,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

ALTER TABLE cards ADD COLUMN buried_until TEXT;
CREATE INDEX idx_cards_buried ON cards(deck_id, buried_until);
