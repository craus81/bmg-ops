-- Migration 329: queue for the daily staff email digest.
--
-- Staff alerts used to email one message per event. On 2026-09-28 that ran
-- Resend's free-plan cap (100 emails/day, every To/CC/BCC counts), so
-- non-urgent alerts now queue their EMAIL copy here and one summary per
-- person goes out each afternoon (/api/cron/staff-email-digest). In-app and
-- push still fire the moment the event happens — only email is batched.
--
-- Service role only (notify() and the cron both use it), so RLS is on with
-- no policies.

CREATE TABLE IF NOT EXISTS staff_email_digest_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Stamped when the digest carrying this row was sent; NULL = pending.
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_staff_email_digest_queue_pending
  ON staff_email_digest_queue(user_id, created_at)
  WHERE sent_at IS NULL;

ALTER TABLE staff_email_digest_queue ENABLE ROW LEVEL SECURITY;
