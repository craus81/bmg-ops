-- Migration 305: customer-requested fresh approval links (R6-11).
--
-- The portal's Action Center lists approvals whose link has lapsed. This
-- records the customer asking for a new one, per record, so that:
--   * the request can be throttled per record — the portal link may be
--     shared across a purchasing team, and without a per-record cooldown
--     one bored click-through mails the approval contact fifty times;
--   * the rep can see the customer asked, and when, next to the record;
--   * the count is separate from approval_reminder_count, which means
--     "times WE chased THEM" and caps the automatic reminder cron at 3.
--     A customer asking for their own link back is not us chasing, and
--     folding it into that counter would both eat an automatic chase and
--     make the escalation message overstate what we sent.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS approval_relink_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_relink_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE wrap_quotes
  ADD COLUMN IF NOT EXISTS approval_relink_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_relink_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS approval_relink_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approval_relink_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN estimates.approval_relink_at IS 'Last time the customer requested a fresh approval link from the portal (R6-11). Distinct from approval_reminder_sent_at, which is an automatic chase we sent.';
COMMENT ON COLUMN wrap_quotes.approval_relink_at IS 'Last time the customer requested a fresh approval link from the portal (R6-11).';
COMMENT ON COLUMN graphics_jobs.approval_relink_at IS 'Last time the customer requested a fresh proof link from the portal (R6-11).';
