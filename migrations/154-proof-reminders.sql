-- Proof-approval reminders + aging: a customer sitting on a proof link
-- blocks production silently. The daily cron auto-resends after 3 quiet
-- days (capped), escalates internally after 7, and the board shows how
-- long each proof has been waiting.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS approval_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_reminder_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS approval_escalated_at TIMESTAMPTZ;

COMMENT ON COLUMN graphics_jobs.approval_reminder_sent_at IS 'Last automatic proof-approval reminder email.';
COMMENT ON COLUMN graphics_jobs.approval_escalated_at IS 'Last internal escalation for a proof stuck awaiting approval.';
