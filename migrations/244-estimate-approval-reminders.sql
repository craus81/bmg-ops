-- Migration 244: automated customer reminders for sent estimates (Stage 3
-- finding: proofs get auto-resend ×3 + escalation; estimates relied on the
-- rep remembering).
--
-- Mirrors the graphics_jobs reminder columns: the daily quote-followup
-- cron emails the customer after 3 quiet days (capped at 3 reminders,
-- tracked here) and escalates internally at 7+ days, re-escalating weekly.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_reminder_sent_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_escalated_at TIMESTAMPTZ;
