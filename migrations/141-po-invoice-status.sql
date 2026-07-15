-- Payment status on PO-linked invoices, pulled from NetSuite during the
-- invoice sync sweeps: 'open' or 'paid' (null when NetSuite reports an
-- unrecognized status), plus the due date so overdue invoices can be
-- called out on the PO screen.
ALTER TABLE po_invoices ADD COLUMN IF NOT EXISTS ns_status TEXT;
ALTER TABLE po_invoices ADD COLUMN IF NOT EXISTS due_date DATE;
