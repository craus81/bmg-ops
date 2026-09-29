-- Migration 331: purchase requests mark themselves ordered from NetSuite POs.
--
-- Before this, a request only left the Purchasing queue when someone pressed
-- "Create PO in NetSuite" on it. A PO keyed straight into NetSuite left the
-- request sitting in the queue as pending, so the queue drifted from reality.
-- Now, after every vendor PO sync and Parts Mail scan, a pending request is
-- matched to an open PO line for the same part from the same vendor, dated on
-- or after the request (src/lib/purchase-request-po-match.ts). The PO's ETA,
-- carrier and tracking — written by the Parts Mail scan — then show on the
-- queue's "On order" list.
--
-- ordered_match: NULL = placed through the queue's Create PO button;
--   'auto' = matched to a PO found in NetSuite.
-- split_from_id: a request only partly covered by a PO line is split — the
--   original row keeps the ordered quantity and a new pending row (pointing
--   back here) carries the rest. Undo folds the remainder back in.
-- auto_match_blocked_po_ids: POs an admin undid a match to, so the next sync
--   doesn't put the request straight back on the same PO.

ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS ordered_match TEXT;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS split_from_id UUID REFERENCES purchase_requests(id) ON DELETE SET NULL;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS auto_match_blocked_po_ids UUID[] NOT NULL DEFAULT '{}';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchase_requests_ordered_match_check') THEN
    ALTER TABLE purchase_requests ADD CONSTRAINT purchase_requests_ordered_match_check
      CHECK (ordered_match IS NULL OR ordered_match IN ('auto'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_purchase_requests_ordered_po ON purchase_requests(ordered_po_id) WHERE ordered_po_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_purchase_requests_split_from ON purchase_requests(split_from_id) WHERE split_from_id IS NOT NULL;
