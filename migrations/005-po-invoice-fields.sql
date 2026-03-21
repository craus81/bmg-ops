-- Add NetSuite invoice tracking to purchase_orders
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS netsuite_invoice_id TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS netsuite_invoice_number TEXT;
