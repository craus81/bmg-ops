-- Duplicate vendor-invoice guard: the same installer invoice recorded twice
-- (two admins processing the same emailed PDF) double-counts installer cost
-- and skews netsuite_parts.avg_install_cost. The API asks for confirmation
-- on a suspected duplicate; these indexes are the hard backstop.
--
-- Two partial indexes because company_id is optional: linked invoices dedupe
-- per company, name-only invoices dedupe per vendor name. If this migration
-- fails with a unique violation, real duplicates already exist — delete the
-- extra copies from Scan Log → Vendor Invoices, then re-run.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_invoices_company_number
  ON vendor_invoices (company_id, lower(invoice_number))
  WHERE invoice_number IS NOT NULL AND company_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_vendor_invoices_name_number
  ON vendor_invoices (lower(vendor_name), lower(invoice_number))
  WHERE invoice_number IS NOT NULL AND company_id IS NULL;
