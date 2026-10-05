-- Migration 339: billable customer on vendor invoice lines (owner ask
-- 2026-10-05).
--
-- Scan Log → Vendor Invoices now lets the recorder pick who BMG bills for
-- the installs on an installer's invoice (an invoice-wide default, with
-- per-line overrides). The pick lands on the scans; this keeps it on the
-- invoice line too, so the invoice history shows which customer each VIN
-- was recorded for. Null = no customer was picked (the scan's customer came
-- from the part or location default, or was already set).
ALTER TABLE vendor_invoice_lines
  ADD COLUMN IF NOT EXISTS billable_customer TEXT;
