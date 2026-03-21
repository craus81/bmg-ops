-- Track multiple invoices created against a single PO
CREATE TABLE IF NOT EXISTS po_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  netsuite_invoice_id TEXT NOT NULL,
  netsuite_invoice_number TEXT,
  line_count INT,
  total_qty INT,
  memo TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_po_invoices_po ON po_invoices(purchase_order_id);
