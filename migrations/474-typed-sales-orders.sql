-- Migration 474: New sales order from nothing.
--
-- Owner decision 2026-10-31 (thread "Redesign order-to-cash and
-- procure-to-pay", answers 1A 2A 3A 4B): anyone with the Estimates or the
-- Invoicing permission can pick a customer, type the lines (any NetSuite item,
-- as New invoice) and an optional ship-to, and FleetSuite makes a NetSuite
-- sales order from O'Fallon (src/lib/new-sales-order.ts, /api/sales-orders/new,
-- page /sales-orders/new). Nothing is billed; no FleetSuite job is made.
--
--   * typed_sales_orders, one row per press of Create sales order, the same
--     shape and claim as typed_invoices (migration 445): its id comes from the
--     page, so a second press of the same form never makes a second order;
--     claimed_at is the claim a try takes; once NetSuite made the order its id
--     and number are kept, and a refused try keeps NetSuite's reason and lets
--     go of the claim.
--
-- Writer and reader: the service role only.

CREATE TABLE IF NOT EXISTS typed_sales_orders (
  id UUID PRIMARY KEY,
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT,
  po_number TEXT,
  memo TEXT,
  vin TEXT,
  -- { name, address, city, state, zip } when typed; NULL = the customer's default ship-to.
  ship_to JSONB,
  -- The lines as sent: [{ itemId, itemNumber, description, quantity, price, discount, taxable }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT,
  claimed_at TIMESTAMPTZ,
  netsuite_so_id TEXT,
  netsuite_so_number TEXT,
  error TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS typed_sales_orders_created_at_idx ON typed_sales_orders (created_at DESC);

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  ALTER TABLE typed_sales_orders ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE typed_sales_orders FROM %I', r);
    END IF;
  END LOOP;
END $$;
