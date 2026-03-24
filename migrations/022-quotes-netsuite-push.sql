-- Migration 022: Add NetSuite push support to quotes table
-- Allows AI-assisted graphics quotes to be pushed as NetSuite Estimates

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS customer_netsuite_id text,
  ADD COLUMN IF NOT EXISTS netsuite_estimate_id text,
  ADD COLUMN IF NOT EXISTS netsuite_estimate_number text,
  ADD COLUMN IF NOT EXISTS pushed_at timestamptz,
  ADD COLUMN IF NOT EXISTS pushed_by uuid REFERENCES profiles(id);

CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_netsuite_estimate_id ON quotes(netsuite_estimate_id);
