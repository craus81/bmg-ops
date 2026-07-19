-- Vendor parts invoices captured from the parts-mail scan: the PDF lands in
-- R2, the extracted header data lands here, and a matched invoice can be
-- turned into a NetSuite vendor bill (PO → bill transform) with one click.

CREATE TABLE IF NOT EXISTS vendor_parts_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id UUID REFERENCES vendor_shipment_emails(id) ON DELETE SET NULL,
  mailbox TEXT,
  file_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,       -- key within the parts-invoices R2 prefix
  content_type TEXT,
  file_size INTEGER,
  vendor_name TEXT,
  invoice_number TEXT,
  invoice_date DATE,
  total NUMERIC(14,2),
  matched_po_id UUID REFERENCES netsuite_vendor_pos(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'captured'
    CHECK (status IN ('captured', 'billed', 'dismissed')),
  netsuite_bill_id TEXT,
  netsuite_bill_number TEXT,
  billed_by UUID REFERENCES profiles(id),
  billed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_parts_invoices_status
  ON vendor_parts_invoices(status, created_at DESC);

ALTER TABLE vendor_parts_invoices ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read parts invoices' AND tablename = 'vendor_parts_invoices') THEN
    CREATE POLICY "Staff read parts invoices" ON vendor_parts_invoices
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
