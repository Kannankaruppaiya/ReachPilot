-- Refresh-token rotation grace (cross-tab logout race fix).
--
-- Problem: two tabs holding the same refresh token can refresh near-simultaneously.
-- The first rotates + revokes the row; the second finds no un-revoked row and
-- 401s, logging the user out. Client-side single-flight only covers one tab.
--
-- Fix: track when a session was rotated and what replaced it, so a just-rotated
-- token presented again within a short grace window is treated as a concurrent
-- race (issue fresh tokens) rather than a reuse/theft (401). See auth.service.ts.
--
-- `rotated_at` is set ONLY on rotation (refresh), never on explicit logout — so
-- logout still hard-revokes (revoked_at set, rotated_at NULL) and cannot be graced.

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS rotated_at  timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES user_sessions(id) ON DELETE SET NULL;
