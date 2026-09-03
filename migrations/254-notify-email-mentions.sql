-- Mentions email by default.
--
-- @mentions went in-app + push only (the mentions route hard-coded its
-- channels, so even "Email Notifications" in Settings never applied), and
-- a rep who wasn't in the app missed being pulled into a job. Owner
-- decision (2026-09-03): anywhere a note can mention someone, the mention
-- ALWAYS emails them unless that user turns it off — so this is an
-- opt-OUT flag, default true, unlike the opt-in email flags around it.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS email_mentions BOOLEAN DEFAULT true;

COMMENT ON COLUMN notification_preferences.email_mentions IS
  'Opt-out: email the user whenever they are @mentioned in a note (in-app + push always fire). Default true; users with no preferences row are treated as true.';
