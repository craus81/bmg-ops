-- Migration 236: dedupe stamp for the prospect-reminder cron (audit Stage 1,
-- "follow-up reminders never notify").
--
-- prospect_reminders rows were written (voice-note API + the record page's
-- manual form) and displayed, but nothing ever delivered them — the table
-- had no sent/notified column for a cron to dedupe on. Mirrors
-- quote_followups.reminder_sent_at (migration 212): the sweep at
-- /api/cron/prospect-reminder-check stamps notified_at when it delivers,
-- so the Vercel cron and the GitHub fallback (which may both run, minutes
-- apart) can't double-notify.
ALTER TABLE prospect_reminders ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- The cron's exact predicate: due, not done, not yet delivered.
CREATE INDEX IF NOT EXISTS idx_prospect_reminders_unnotified
  ON prospect_reminders(due_at) WHERE completed_at IS NULL AND notified_at IS NULL;
