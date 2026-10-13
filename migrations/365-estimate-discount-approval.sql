-- Migration 365: a description on each discount, and admin approval for big
-- discounts.
--
-- Valarie's notes, Craig's answers (2026-10-13):
--  * "a spot to add a description by the discount button" -- the customer
--    sees it: "Fleet loyalty (10%)" on the quote, PDF, approval page and the
--    NetSuite discount line. One on the whole-job discount (migration 342)
--    and one per line discount (migration 350).
--  * Controls on discounting: reps discount up to a set percent of the job
--    on their own (5%); above that an admin approves before the estimate
--    can be sent to the customer or pushed to NetSuite. See
--    src/lib/discount-approval.ts.
--
-- The approval is stamped with the percent it covered, so it holds while the
-- discounts stay at or under that percent and lapses if a rep raises them.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_description TEXT;
ALTER TABLE estimate_line_items ADD COLUMN IF NOT EXISTS discount_description TEXT;

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_approval_requested_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_approval_requested_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_approved_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS discount_approved_pct NUMERIC(6,2);

ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS discount_approval_pct NUMERIC(5,2) NOT NULL DEFAULT 5;

COMMENT ON COLUMN estimates.discount_description IS
  'Customer-facing words for the whole-job discount, e.g. "Fleet loyalty" (migration 365).';
COMMENT ON COLUMN estimate_line_items.discount_description IS
  'Customer-facing words for this line''s discount (migration 365).';
COMMENT ON COLUMN estimates.discount_approved_pct IS
  'The discount percent of the job an admin approved; the approval holds while discounts stay at or under it.';
COMMENT ON COLUMN quote_settings.discount_approval_pct IS
  'Discounts above this percent of the job need an admin to approve them before sending or pushing (Craig 2026-10-13: 5).';
