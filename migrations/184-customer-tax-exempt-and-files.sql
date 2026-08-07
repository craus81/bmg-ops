-- Migration 184: Customer-level tax exemption + a PRIVATE customer files
-- store (E5 — "Upload tax exempt forms").
--
-- Two parts:
--   1. tax_exempt fields on customers so the exemption is a customer default
--      (with cert number + expiry), not just a bare per-estimate checkbox
--      with nothing backing it. The estimate builder prefills its tax-exempt
--      toggle from these and shows "cert on file · exp MM/YYYY".
--   2. customer_files — resale/exemption certificates and other customer
--      documents. UNLIKE prospect_files (migration 179), this table stores NO
--      public URL: certs carry EINs, so the object is never linked publicly;
--      downloads stream through the staff-gated /api/customers/files route.

-- ═══════════ customers — tax exemption (FleetSuite-owned) ═══════════
-- FleetSuite-owned, like the migration-080 columns: the hourly NetSuite sync
-- (src/app/api/cron/netsuite-sync/route.ts) only writes NS-sourced fields in
-- its upsert SET list, so these are never clobbered on resync.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS tax_exempt BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tax_exempt_cert_number TEXT,
  ADD COLUMN IF NOT EXISTS tax_exempt_expires_at DATE;

COMMENT ON COLUMN customers.tax_exempt IS 'FleetSuite-owned. Customer is tax-exempt by default; prefills the estimate tax-exempt flag.';
COMMENT ON COLUMN customers.tax_exempt_cert_number IS 'FleetSuite-owned. Resale/exemption certificate number backing the exemption.';
COMMENT ON COLUMN customers.tax_exempt_expires_at IS 'FleetSuite-owned. Certificate expiry; drives the "expiring/expired" warning next to the flag.';

-- ═══════════ customer_files — PRIVATE document store ═══════════
-- Storage lives in R2 under the 'customer-files' prefix (browser uploads go
-- direct via presigned PUT — /api/customers/files). Rows are metadata + the
-- storage path ONLY. No public_url column on purpose: certs are sensitive, so
-- the app never hands out a public link — downloads are streamed by the
-- staff-gated route.
CREATE TABLE IF NOT EXISTS customer_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- 'tax_exempt_cert' for exemption certificates; 'general' for anything else.
  category TEXT NOT NULL DEFAULT 'general',
  file_name TEXT NOT NULL,
  content_type TEXT,
  size_bytes BIGINT,
  storage_path TEXT NOT NULL, -- path under the 'customer-files' R2 prefix
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_files_customer ON customer_files(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_files_category ON customer_files(customer_id, category);

ALTER TABLE customer_files ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage customer files' AND tablename = 'customer_files') THEN
    CREATE POLICY "Internal staff can manage customer files" ON customer_files
      FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;
