-- SRS Phase 2: FSRS tuning, leeches, suspension, statistics

ALTER TABLE deck_settings ADD COLUMN desired_retention REAL NOT NULL DEFAULT 0.9;
ALTER TABLE deck_settings ADD COLUMN max_interval INTEGER NOT NULL DEFAULT 36500;
ALTER TABLE deck_settings ADD COLUMN leech_threshold INTEGER NOT NULL DEFAULT 8;

ALTER TABLE cards ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_cards_suspended ON cards(deck_id, suspended);
