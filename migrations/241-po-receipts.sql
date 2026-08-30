-- Migration 241: PO receipts — the receiving half of audit item 17
-- ("Parts ordering and receiving — still no software at all: ... no
-- receiving flow").
--
-- A row is one "N of this part arrived at the dock against this vendor
-- PO", recorded from /admin/receiving. The route attempts the NetSuite
-- item receipt (purchaseOrder → itemReceipt transform) in the same call:
-- ns_status 'posted' means NetSuite has it (ns_receipt_id/number filled);
-- 'manual_needed' means the transform failed or couldn't be mapped and
-- the receipt must be keyed into NetSuite by hand (the page's worklist);
-- 'manual_done' is that worklist row dismissed after hand entry.
--
-- Deliberately NOT keyed to netsuite_vendor_po_lines rows: the 2-hourly
-- sync deletes and reinserts those wholesale, so any FK there would be
-- severed within hours. po_id references the stable PO header row (upsert
-- on netsuite_id, never deleted); line_id/item fields are copied text.
CREATE TABLE IF NOT EXISTS po_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES netsuite_vendor_pos(id) ON DELETE CASCADE,
  po_netsuite_id TEXT,
  line_id TEXT,
  item_netsuite_id TEXT,
  item_number TEXT NOT NULL,
  description TEXT,
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  note TEXT,
  ns_status TEXT NOT NULL DEFAULT 'manual_needed'
    CHECK (ns_status IN ('posted', 'manual_needed', 'manual_done')),
  ns_receipt_id TEXT,
  ns_receipt_number TEXT,
  received_by UUID REFERENCES profiles(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_receipts_po ON po_receipts(po_id);
CREATE INDEX IF NOT EXISTS idx_po_receipts_manual
  ON po_receipts(received_at DESC) WHERE ns_status = 'manual_needed';

ALTER TABLE po_receipts ENABLE ROW LEVEL SECURITY;

-- Staff read; ALL writes go through /api/po-receipts (service role), which
-- owns the NetSuite transform attempt, mirror bump, and notifications.
DO $$ BEGIN
  CREATE POLICY "staff_read_po_receipts" ON po_receipts
    FOR SELECT TO authenticated USING (public.is_internal_staff());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
