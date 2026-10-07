-- Migration 347: snooze an estimate's internal review (owner ask 2026-10-07).
--
-- The overdue-review reminder (migration 344) pings every admin. When the
-- team already knows an estimate is waiting on something, the reviewer or
-- any admin can snooze it for 1 day, 3 days or a week: one snooze quiets it
-- for the whole team (Craig's call), and when it runs out the reminder goes
-- out once more. A fresh Send for Review clears the snooze.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS internal_review_snoozed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS internal_review_snoozed_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
