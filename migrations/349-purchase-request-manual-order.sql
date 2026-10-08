-- Migration 349: an admin can mark purchase requests ordered by hand.
--
-- Until now a request left the Purchasing queue only through the queue's
-- Create PO button or the automatic match to a NetSuite PO (migration 331).
-- Now an admin can also press "Mark ordered" and type the PO number the parts
-- were bought on. When that PO is already mirrored from NetSuite the request
-- links to it straight away; otherwise the typed number waits in
-- ordered_po_number and the next vendor PO sync links it
-- (linkManualOrders in src/lib/purchase-request-po-match.ts). Once linked, the
-- auto-match counts the request against that PO's lines, so the same PO line
-- isn't handed to a second request.
--
-- ordered_match: NULL = Create PO; 'auto' = matched to a NetSuite PO;
--   'manual' = marked ordered by an admin.

ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS ordered_po_number TEXT;

ALTER TABLE purchase_requests DROP CONSTRAINT IF EXISTS purchase_requests_ordered_match_check;
ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_ordered_match_check
  CHECK (ordered_match IS NULL OR ordered_match IN ('auto', 'manual'));

CREATE INDEX IF NOT EXISTS idx_purchase_requests_manual_unlinked
  ON purchase_requests(ordered_po_number)
  WHERE status = 'ordered' AND ordered_match = 'manual' AND ordered_po_id IS NULL;
