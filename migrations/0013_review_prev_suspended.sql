-- 0013_review_prev_suspended.sql
-- Capture a card's `suspended` flag on each review snapshot so undo can restore the
-- *actual* prior value instead of always unsuspending. Pre-existing rows remain NULL;
-- undo treats NULL as "leave suspended as-is" (safe no-op for old reviews).

ALTER TABLE reviews ADD COLUMN prev_suspended INTEGER;
