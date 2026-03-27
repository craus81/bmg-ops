-- Add ship_to address column to purchase_orders
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS ship_to jsonb DEFAULT NULL;

-- ship_to stores: { "name": "...", "address": "...", "city": "...", "state": "...", "zip": "..." }
