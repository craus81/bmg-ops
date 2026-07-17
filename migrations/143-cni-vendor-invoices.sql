-- CNI vendor invoices: record what we actually paid an installer per VIN.
-- Uploaded (or manually entered) from the Scan Log → Vendor Invoices tab.
-- Lines link to scan_logs rows — existing scans get cost info stamped on
-- without touching their lifecycle stamps; VINs not yet in the system get a
-- fresh scan_logs row. netsuite_parts carries a running average of the
-- per-VIN installer cost so margins are visible on the part record.

CREATE TABLE IF NOT EXISTS vendor_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_number TEXT,
  invoice_date DATE,
  -- Who we paid. CNI installers are companies rows (solo installers get a
  -- one-person company per migration 122); vendor_name is a display snapshot
  -- so the record survives a company rename/delete.
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  vendor_name TEXT NOT NULL,
  total_amount NUMERIC(12,2),
  location_id UUID REFERENCES work_locations(id),
  location_name TEXT,
  file_name TEXT,
  storage_path TEXT,
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoices_company ON vendor_invoices(company_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoices_created ON vendor_invoices(created_at DESC);

CREATE TABLE IF NOT EXISTS vendor_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_invoice_id UUID NOT NULL REFERENCES vendor_invoices(id) ON DELETE CASCADE,
  scan_log_id UUID REFERENCES scan_logs(id) ON DELETE SET NULL,
  vin TEXT NOT NULL,
  part_number TEXT,
  amount NUMERIC(10,2),
  -- true = the VIN was already in scan_logs when this invoice was recorded
  -- (retroactive upload); its scan kept whatever lifecycle state it had.
  was_existing_scan BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invoice_lines_invoice ON vendor_invoice_lines(vendor_invoice_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoice_lines_scan ON vendor_invoice_lines(scan_log_id);
CREATE INDEX IF NOT EXISTS idx_vendor_invoice_lines_part ON vendor_invoice_lines(part_number);

-- Latest installer-cost info stamped straight onto the scan record for quick
-- display and reporting. History (multiple invoices per VIN) stays in
-- vendor_invoice_lines.
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS install_cost NUMERIC(10,2);
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS installer_name TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS vendor_invoice_id UUID REFERENCES vendor_invoices(id) ON DELETE SET NULL;

-- Running average of what we've paid installers per unit of this part,
-- recomputed from vendor_invoice_lines (robust to edits/deletes, unlike an
-- incremental counter).
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS avg_install_cost NUMERIC(12,2);
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS install_cost_count INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.recompute_part_install_cost(p_part_number TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE public.netsuite_parts np
  SET avg_install_cost = agg.avg_amount,
      install_cost_count = agg.n
  FROM (
    SELECT ROUND(AVG(amount), 2) AS avg_amount, COUNT(*)::int AS n
    FROM public.vendor_invoice_lines
    WHERE upper(part_number) = upper(p_part_number)
      AND amount IS NOT NULL
  ) agg
  WHERE lower(np.item_number) = lower(p_part_number);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

ALTER TABLE vendor_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_invoice_lines ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage vendor invoices' AND tablename = 'vendor_invoices') THEN
    CREATE POLICY "Internal staff can manage vendor invoices" ON vendor_invoices
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage vendor invoice lines' AND tablename = 'vendor_invoice_lines') THEN
    CREATE POLICY "Internal staff can manage vendor invoice lines" ON vendor_invoice_lines
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
