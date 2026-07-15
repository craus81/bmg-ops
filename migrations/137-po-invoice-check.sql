-- Invoiced-quantity verification. The check compares each PO's ordered
-- quantities against the summed line quantities of its linked NetSuite
-- invoices (po_invoices) and stamps the result here:
--   invoice_check_status: 'ok' | 'attention' (NULL = never checked / no
--                         invoices linked)
--   invoice_check:        details JSON — { checked_at, invoice_count,
--                         problems: [..], lines: [{ part_number, ordered,
--                         invoiced, status: ok|over|under|extra }] }
-- Populated by /api/pos/verify-invoices (manual button) and the
-- netsuite-sync cron after each invoice sweep.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_check JSONB;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS invoice_check_status TEXT;
