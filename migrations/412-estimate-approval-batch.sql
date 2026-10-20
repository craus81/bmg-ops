-- One approval email for a fleet order (Craig, 2026-10-19). A fleet order
-- (estimates.fleet_group_id, migration 410) can go to the customer in ONE
-- email: every unapproved vehicle's estimate gets its own approval token as
-- usual, and all of them share this batch id. The order's approval page
-- (/approve/fleet/[token]) finds the other vehicles of the same send by it.
-- A vehicle sent again on its own gets a new token and loses the batch id,
-- so the order page only ever lists links from that one email.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_batch_id UUID;

CREATE INDEX IF NOT EXISTS idx_estimates_approval_batch
  ON estimates (approval_batch_id)
  WHERE approval_batch_id IS NOT NULL;

COMMENT ON COLUMN estimates.approval_batch_id IS
  'Shared by the estimates of a fleet order sent for approval in one email; null for a single send.';
