-- Phase 3: FSRS snapshot columns on reviews for server-side undo
ALTER TABLE reviews ADD COLUMN prev_due_at TEXT;
ALTER TABLE reviews ADD COLUMN prev_fsrs_state INTEGER;
ALTER TABLE reviews ADD COLUMN prev_fsrs_stability REAL;
ALTER TABLE reviews ADD COLUMN prev_fsrs_difficulty REAL;
ALTER TABLE reviews ADD COLUMN prev_fsrs_elapsed_days INTEGER;
ALTER TABLE reviews ADD COLUMN prev_fsrs_scheduled_days INTEGER;
ALTER TABLE reviews ADD COLUMN prev_fsrs_reps INTEGER;
ALTER TABLE reviews ADD COLUMN prev_fsrs_lapses INTEGER;
ALTER TABLE reviews ADD COLUMN prev_fsrs_last_review TEXT;
