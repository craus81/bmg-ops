-- Migration 344: overdue internal-review reminder (owner ask 2026-10-06).
--
-- An estimate sent for internal review (migration 316) that is still
-- pending after 6 shop hours pings every admin plus the assigned reviewer,
-- once per review round (/api/cron/estimate-review-reminder). This stamp is
-- the dedupe: a round counts as reminded when the stamp is newer than
-- internal_review_requested_at, so a fresh Send for Review starts a new
-- round without any other route having to clear it.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS internal_review_reminded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS estimates_internal_review_pending_idx
  ON estimates (internal_review_requested_at)
  WHERE internal_review_status = 'pending';
