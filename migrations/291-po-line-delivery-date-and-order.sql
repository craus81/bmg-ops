-- PO line items keep their requested delivery date and their place in the PO.
--
-- Field bug (PO 35050306): the receipt confirmation's "Requested" column
-- rendered "—" on every row of every PO ever sent, and the rows came out in
-- an order that matched nothing on the customer's document.
--
-- Both had the same shape of cause. The extractor reads a per-line
-- "Requested Delivery Date" and a line number off the PDF — the header-level
-- requested_delivery_date is literally derived from the earliest of those
-- dates — but neither value had a column to land in, so both were dropped on
-- the way into po_line_items. src/lib/po-confirmation.ts then read
-- l.delivery_date (always null) and ordered by id, which is a UUID, so the
-- email listed line 3 above line 2.
--
-- line_no is the PO's own printed line number (1.000, 2.000 …) as NUMERIC so
-- it sorts correctly; the importer falls back to the line's position when a
-- PO prints no line numbers.

ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS delivery_date DATE;
ALTER TABLE po_line_items ADD COLUMN IF NOT EXISTS line_no NUMERIC(12, 3);

-- Ordering a PO's lines is the only read pattern for line_no.
CREATE INDEX IF NOT EXISTS idx_po_line_items_po_line_no ON po_line_items(po_id, line_no);

COMMENT ON COLUMN po_line_items.delivery_date IS
  'Requested delivery date for this line, off the PO PDF. Feeds the "Requested" column of the PO receipt confirmation (migration 291).';
COMMENT ON COLUMN po_line_items.line_no IS
  'The PO''s own printed line number (1.000, 2.000 …), or the line''s 1-based position when the PO prints none. Orders the lines as the customer sees them (migration 291).';
