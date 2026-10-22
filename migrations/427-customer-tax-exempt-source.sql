-- Migration 427: where a customer's tax exemption came from, and what
-- NetSuite thinks.
--
-- Owner request 2026-10-22 (thread "Permanent tax exempt customers"):
-- Masterack is a reseller and NetSuite already leaves its invoices untaxed,
-- but FleetSuite's own copy of INV2624 charged it 7.95% because nobody had
-- ticked the FleetSuite flag (migration 184), which only lived behind an
-- estimate's "Edit defaults". Now:
--   * the netsuite-sync cron copies NetSuite's customer Taxable box into
--     netsuite_taxable (NetSuite-owned, overwritten every run), and marks a
--     customer exempt when NetSuite has Taxable off, one way only
--     (src/lib/customer-tax-exempt.ts);
--   * tax_exempt_source says who last set tax_exempt: 'netsuite' (that
--     copy) or 'staff' (the customer page, an estimate's Edit defaults).
--     Once staff set it either way the sync leaves it alone, so turning a
--     customer back to taxed in FleetSuite sticks.
-- An expired certificate only shows a warning; it never turns tax back on.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS netsuite_taxable BOOLEAN,
  ADD COLUMN IF NOT EXISTS tax_exempt_source TEXT,
  ADD COLUMN IF NOT EXISTS tax_exempt_changed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_tax_exempt_source_check') THEN
    ALTER TABLE customers ADD CONSTRAINT customers_tax_exempt_source_check
      CHECK (tax_exempt_source IS NULL OR tax_exempt_source IN ('netsuite', 'staff'));
  END IF;
END $$;

-- Customers already ticked by hand before this migration were set by staff.
UPDATE customers SET tax_exempt_source = 'staff'
  WHERE tax_exempt = true AND tax_exempt_source IS NULL;

COMMENT ON COLUMN customers.netsuite_taxable IS 'NetSuite-owned: the customer''s Taxable box, copied by /api/cron/netsuite-sync. NULL = not read yet.';
COMMENT ON COLUMN customers.tax_exempt_source IS 'FleetSuite-owned: who last set tax_exempt, ''netsuite'' (copied from Taxable off) or ''staff''. Staff-set rows are never changed by the sync.';
COMMENT ON COLUMN customers.tax_exempt_changed_at IS 'FleetSuite-owned: when tax_exempt was last set.';
