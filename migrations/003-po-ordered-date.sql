-- Add ordered_date column to purchase_orders to store the actual PO date from the document
-- (as opposed to created_at which is when it was imported into the system)
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ordered_date DATE;
