-- Add requested_delivery_date to purchase_orders
-- On Masterack POs this is the header field labeled "REQUESTED DELIVERY DATE".
-- Used to seed the due_date on graphics jobs created from a PO.
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS requested_delivery_date DATE;
