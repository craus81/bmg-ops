-- Per-VIN revenue actually billed to the customer. Stamped by
-- /api/netsuite/invoice-vehicles at invoice-creation time (each scan's share
-- of a part line is exactly that part's billed rate, since quantity = VIN
-- count). Scans invoiced before this column existed get their actuals from a
-- NetSuite invoice-line lookup inside the installer-costs report instead.
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS invoiced_amount NUMERIC(12,2);
