-- Migration 031: Add NetSuite tracking and creator info to portal_orders

ALTER TABLE portal_orders
  ADD COLUMN IF NOT EXISTS netsuite_so_id     TEXT,
  ADD COLUMN IF NOT EXISTS netsuite_so_number TEXT,
  ADD COLUMN IF NOT EXISTS created_by         UUID REFERENCES auth.users(id);

CREATE INDEX IF NOT EXISTS idx_portal_orders_netsuite ON portal_orders(netsuite_so_id) WHERE netsuite_so_id IS NOT NULL;
