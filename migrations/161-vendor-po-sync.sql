-- Upfit hub phase 2: vendor purchase orders synced from NetSuite.
-- BMG's POs to parts vendors (Ranger Design, Masterack, Legend, Meyer,
-- Buyers, ...) land here so FleetSuite can answer "what's on order" per
-- part number — the seed of full inventory tracking (on hand / allocated /
-- waiting) and the data the upfit parts-readiness check reads.

CREATE TABLE IF NOT EXISTS netsuite_vendor_pos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  netsuite_id TEXT NOT NULL UNIQUE,   -- transaction internal id
  tranid TEXT,                        -- PO number as shown in NetSuite
  vendor_netsuite_id TEXT,
  vendor_name TEXT,
  trandate DATE,
  status TEXT,                        -- raw NetSuite status code (letter)
  status_label TEXT,                  -- display name when available
  memo TEXT,
  total NUMERIC(14,2),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ns_vendor_pos_vendor ON netsuite_vendor_pos(vendor_name);
CREATE INDEX IF NOT EXISTS idx_ns_vendor_pos_date ON netsuite_vendor_pos(trandate DESC);

CREATE TABLE IF NOT EXISTS netsuite_vendor_po_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES netsuite_vendor_pos(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,              -- transactionline id within the PO
  item_netsuite_id TEXT,
  item_number TEXT,                   -- normalized (last ":" segment, uppercased)
  description TEXT,
  quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantity_received NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantity_billed NUMERIC(14,2) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4),
  amount NUMERIC(14,2),
  UNIQUE (po_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_ns_vendor_po_lines_item ON netsuite_vendor_po_lines(item_number);
CREATE INDEX IF NOT EXISTS idx_ns_vendor_po_lines_po ON netsuite_vendor_po_lines(po_id);

-- Staff read; writes come from the sync (service role).
ALTER TABLE netsuite_vendor_pos ENABLE ROW LEVEL SECURITY;
ALTER TABLE netsuite_vendor_po_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read vendor POs' AND tablename = 'netsuite_vendor_pos') THEN
    CREATE POLICY "Staff read vendor POs" ON netsuite_vendor_pos
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read vendor PO lines' AND tablename = 'netsuite_vendor_po_lines') THEN
    CREATE POLICY "Staff read vendor PO lines" ON netsuite_vendor_po_lines
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
