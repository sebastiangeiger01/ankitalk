-- Learning steps: traditional Anki-style fixed learning steps (1m, 10m by default)
-- FSRS only computes the graduation interval, not learning phase intervals.

ALTER TABLE deck_settings ADD COLUMN learning_steps TEXT NOT NULL DEFAULT '1,10';
ALTER TABLE deck_settings ADD COLUMN relearning_steps TEXT NOT NULL DEFAULT '10';

ALTER TABLE cards ADD COLUMN learning_step_index INTEGER NOT NULL DEFAULT 0;

-- Snapshot for undo
ALTER TABLE reviews ADD COLUMN prev_learning_step_index INTEGER;
