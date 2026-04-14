-- Add Sales Order tracking fields to estimates table
-- Allows tracking when an estimate has been converted to a NetSuite Sales Order
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS netsuite_so_id text;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS netsuite_so_number text;
