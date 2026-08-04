-- ============================================================================
-- 0007: Campaign sequence engine — enrollment step timing
--
-- The graph executor already drives enrollments through campaign_steps, but a
-- CONDITION step ("if not accepted in 7 days → email") needs to know how long a
-- lead has sat on the current step to honour the step's delay window and time
-- out the false branch. `step_entered_at` records when the enrollment's
-- current_step_id was last set; the runner compares it against the step's
-- delay_hours. Additive + backfilled, so instant with no rewrite.
-- ============================================================================

ALTER TABLE enrollments
  ADD COLUMN IF NOT EXISTS step_entered_at timestamptz;

-- Backfill existing rows so the timeout math has a baseline.
UPDATE enrollments
   SET step_entered_at = COALESCE(enrolled_at, now())
 WHERE step_entered_at IS NULL;
