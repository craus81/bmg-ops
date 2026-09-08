-- R6-7 (purchasing batch, part 1): the vendor master and structured dock
-- exceptions. Both hang off receiving, which is why they ship together.
--
-- 1. VENDOR MASTER. Vendor names live as free text on purchase_requests
--    and PO mirrors, so "Grimco", "GRIMCO" and "Grimco Inc" are three
--    vendors to every report that groups by them. A nightly mirror of
--    NetSuite's vendor list gives the app real ids, terms and contacts.
--
-- 2. DOCK EXCEPTIONS. Receiving records what ARRIVED; when a line comes
--    up short, damaged or wrong, that fact lived in a free-text note if it
--    was recorded at all — so nobody could work a list of open vendor
--    claims. One row per problem, with an explicit resolution.

CREATE TABLE IF NOT EXISTS netsuite_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  netsuite_id TEXT NOT NULL UNIQUE,
  entity_id TEXT,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  terms TEXT,
  is_inactive BOOLEAN NOT NULL DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reports group vendors by name; this is the index that makes the lookup
-- from a free-text name cheap.
CREATE INDEX IF NOT EXISTS idx_netsuite_vendors_name ON netsuite_vendors(lower(company_name));
CREATE INDEX IF NOT EXISTS idx_netsuite_vendors_entity ON netsuite_vendors(lower(entity_id));

ALTER TABLE netsuite_vendors ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff read vendor master" ON netsuite_vendors;
CREATE POLICY "Staff read vendor master" ON netsuite_vendors
  FOR SELECT TO authenticated USING (public.is_internal_staff());
-- Written by the nightly sync (service role) only.

CREATE TABLE IF NOT EXISTS po_receipt_exceptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID REFERENCES po_receipts(id) ON DELETE SET NULL,
  -- The PO header is the stable anchor: the 2-hourly sync deletes and
  -- reinserts mirror LINES wholesale, so nothing here may reference them
  -- (the same trap po_receipts documents in migration 241).
  po_id UUID NOT NULL REFERENCES netsuite_vendor_pos(id) ON DELETE CASCADE,
  item_number TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('short', 'damaged', 'wrong_item')),
  quantity NUMERIC(14,2) CHECK (quantity IS NULL OR quantity >= 0),
  note TEXT,
  photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  -- How it ended: a credit chased, a replacement ordered, or eaten.
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('vendor_credit', 'replacement_po', 'written_off')),
  resolution_note TEXT,
  resolved_by UUID REFERENCES profiles(id),
  resolved_at TIMESTAMPTZ,
  flagged_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A resolved row must say HOW, or the queue quietly loses claims.
  CONSTRAINT dock_exception_resolution_required
    CHECK (status <> 'resolved' OR resolution IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_po_receipt_exceptions_open
  ON po_receipt_exceptions(created_at DESC) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_po_receipt_exceptions_po ON po_receipt_exceptions(po_id);

ALTER TABLE po_receipt_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff manage dock exceptions" ON po_receipt_exceptions;
CREATE POLICY "Staff manage dock exceptions" ON po_receipt_exceptions
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());

COMMENT ON CONSTRAINT dock_exception_resolution_required ON po_receipt_exceptions IS
  'R6-7: closing a discrepancy requires saying how it ended — credit, replacement, or written off.';
