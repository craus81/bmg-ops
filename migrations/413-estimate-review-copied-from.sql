-- A copied estimate keeps its review until something changes (Craig and
-- Valarie, 2026-10-19). Duplicate and "Copy for more vehicles" carry an
-- APPROVED internal review onto the copy, since the copy has exactly the
-- reviewed lines and prices; the copy's banner names the estimate the
-- review was given on. The first save that changes a line or a price
-- clears the review (on any estimate, copy or not), so it has to go
-- through Send for Review again.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS internal_review_copied_from TEXT;

COMMENT ON COLUMN estimates.internal_review_copied_from IS
  'Estimate number the approved internal review was given on, when this estimate is an unchanged copy of it. NULL = reviewed on this estimate itself (or not reviewed). Cleared with the review when lines or prices change.';
