-- Manual invoice-line matches for the PO billing check.
--
-- The check (src/lib/po-invoice-verify.ts) pairs a NetSuite invoice line with
-- a PO line only when the item names agree. Some POs carry no real part
-- number (just an SO#, say), so a correctly billed invoice line such as
-- "INSTALL LABOR CUSTOMER SUPPLIED PARTS" reads as 'extra — not on this PO'
-- and its quantity never counts against the PO. An admin can now point that
-- invoice item at the PO line it actually billed; the check then counts it
-- there on every run, so the PO reads fully invoiced (Fulfilled) without
-- being closed (owner decision, 2026-09-25).
--
-- One row per (PO, invoice item): the match is per PO so a generic labor
-- item on one PO never silently matches on another. invoice_item holds the
-- normalized item key the check uses (normPart: last ':' segment, upper-case).
--
-- Writes go through /api/pos/match-invoice-item (admin-only, service role,
-- audit-logged), so there are no client write policies.

CREATE TABLE IF NOT EXISTS po_invoice_item_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  invoice_item TEXT NOT NULL,
  po_line_item_id UUID NOT NULL REFERENCES po_line_items(id) ON DELETE CASCADE,
  note TEXT,
  matched_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  matched_by_name TEXT,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, invoice_item)
);

CREATE INDEX IF NOT EXISTS idx_po_invoice_item_matches_line
  ON po_invoice_item_matches(po_line_item_id);

ALTER TABLE po_invoice_item_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS po_invoice_item_matches_read ON po_invoice_item_matches;
CREATE POLICY po_invoice_item_matches_read ON po_invoice_item_matches
  FOR SELECT TO authenticated
  USING (public.get_my_roles() && ARRAY['admin', 'super_admin']);
