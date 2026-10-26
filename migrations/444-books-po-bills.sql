-- Migration 444: FleetSuite's own books, part 29 — shared bills, the third
-- piece: PO bills.
--
-- Owner decision 2026-10-25 (thread "Replacing NetSuite with FleetSuite",
-- "Freight line", as Books Previews drew it): a snapped bill that names an
-- open purchase order bills that PO in NetSuite, the way Parts Mail's Create
-- bill does, after the same three-way match (src/lib/three-way-match.ts):
-- NetSuite bills the PO's open lines at its prices, and what the vendor's bill
-- has beyond them goes on the same bill as its own line, to an account picked
-- for it. A check that didn't pass needs a reason, which goes in the audit
-- log as Parts Mail's does (src/lib/books/snap-po.ts, snap-a-bill.ts,
-- /api/admin/books/snap-a-bill).
--
-- gl_snapped_bills keeps, with the form as last saved:
--   * po_number, the PO the bill names, as read off it or typed;
--   * how_billed, 'po' or 'plain' once someone picks (null: the PO is billed
--     when it can take the bill);
--   * override_reason, why the PO is billed past a check that didn't pass;
--   * extra_line, the line for what the bill has beyond the PO:
--     { description, account_netsuite_id, picked, left_off };
-- and once sent by billing a PO, the PO it billed (billed_po_netsuite_id,
-- billed_po_number) and what went on the extra line (billed_extra). A PO a
-- snapped bill billed counts as an earlier bill in the three-way match, for
-- Parts Mail's Create bill too, until the copy of NetSuite's POs shows it
-- billed.
--
-- Writer and reader: the service role only, as migration 436 set up.

ALTER TABLE gl_snapped_bills
  ADD COLUMN IF NOT EXISTS po_number TEXT,
  ADD COLUMN IF NOT EXISTS how_billed TEXT CHECK (how_billed IN ('po', 'plain')),
  ADD COLUMN IF NOT EXISTS override_reason TEXT,
  ADD COLUMN IF NOT EXISTS extra_line JSONB CHECK (extra_line IS NULL OR jsonb_typeof(extra_line) = 'object'),
  ADD COLUMN IF NOT EXISTS billed_po_netsuite_id TEXT CHECK (billed_po_netsuite_id ~ '^[0-9]+$'),
  ADD COLUMN IF NOT EXISTS billed_po_number TEXT,
  ADD COLUMN IF NOT EXISTS billed_extra NUMERIC(14,2) CHECK (billed_extra > 0);

-- Only a sent bill billed a PO, and only a bill that billed a PO carried an extra line with it.
ALTER TABLE gl_snapped_bills DROP CONSTRAINT IF EXISTS gl_snapped_bills_billed_po_check;
ALTER TABLE gl_snapped_bills ADD CONSTRAINT gl_snapped_bills_billed_po_check
  CHECK ((billed_po_netsuite_id IS NULL OR status = 'sent') AND (billed_extra IS NULL OR billed_po_netsuite_id IS NOT NULL));

CREATE INDEX IF NOT EXISTS idx_gl_snapped_bills_billed_po
  ON gl_snapped_bills(billed_po_netsuite_id) WHERE billed_po_netsuite_id IS NOT NULL;
