-- Migration 461: the invoices billed from an estimate's sales order.
--
-- Owner decision 2026-10-31 (thread "Auto-link invoice when linking a sales
-- order", option C): when an existing NetSuite sales order is linked to an
-- estimate, the invoices billed from it come with it, automatically, on the
-- estimate and on the estimate's vehicles, partly billed orders included,
-- and every estimate already linked is filled in once.
--
-- NetSuite already knows which invoice came from which sales order
-- (src/lib/so-invoices.ts reads its line links). This keeps FleetSuite's
-- copy per estimate (src/lib/estimate-invoices.ts):
--   * estimate_invoices, one row per invoice billed from the estimate's SO,
--     voided ones left out. Replaced whole for the estimate on every check.
--   * estimates.so_billing, 'none' / 'partial' / 'full' as of the last check
--     (full = NetSuite says the SO is Billed or Closed).
--   * estimates.invoices_checked_at, when it was last checked. The two-hour
--     NetSuite sync works through linked estimates oldest-checked first, so
--     the ones linked before this migration (never checked) fill in over its
--     next few runs.
--
-- Nothing here is written to NetSuite. Every write goes through the service
-- role; staff can read (the In-Shop board's Partly billed badge), the same as
-- fleet_checkin_invoices (migration 261). The estimate screen reads it
-- through /api/estimates/[id]/invoices, which leaves amounts out for anyone
-- without See prices.

CREATE TABLE IF NOT EXISTS estimate_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  netsuite_so_id TEXT NOT NULL,
  netsuite_invoice_id TEXT NOT NULL,
  invoice_number TEXT NOT NULL,
  invoice_date DATE,
  total NUMERIC(14,2),
  status TEXT,
  found_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (estimate_id, netsuite_invoice_id)
);
CREATE INDEX IF NOT EXISTS idx_estimate_invoices_estimate ON estimate_invoices(estimate_id);

ALTER TABLE public.estimates
  ADD COLUMN IF NOT EXISTS so_billing TEXT CHECK (so_billing IN ('none', 'partial', 'full')),
  ADD COLUMN IF NOT EXISTS invoices_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_estimates_invoices_checked
  ON estimates(invoices_checked_at NULLS FIRST)
  WHERE netsuite_so_id IS NOT NULL;

ALTER TABLE estimate_invoices ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'estimate_invoices'
      AND policyname = 'estimate_invoices_staff_select'
  ) THEN
    CREATE POLICY estimate_invoices_staff_select ON estimate_invoices
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;
