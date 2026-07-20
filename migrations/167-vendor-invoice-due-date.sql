-- Payment due date on CNI vendor invoices (extracted by AI or entered on the
-- Scan Log → Vendor Invoices review form) so AP can prioritize the queue.

ALTER TABLE vendor_invoices ADD COLUMN IF NOT EXISTS due_date DATE;
