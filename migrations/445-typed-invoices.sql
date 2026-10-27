-- Migration 445: New invoice from nothing.
--
-- Owner decision 2026-10-26/27 (thread "Redesign order-to-cash and
-- procure-to-pay", answers 1A 2A 3C 4A): anyone with the Invoicing permission
-- can pick a customer, type the lines (any NetSuite item) and make a
-- standalone invoice in NetSuite, shipped from O'Fallon, with no sales order
-- (src/lib/new-invoice.ts, /api/invoices/new, page /invoices/new).
--
--   * typed_invoices, one row per press of Create invoice. Its id comes from
--     the page, so a second press of the same form (a double tap, a retry
--     after a dropped connection) finds the row and never makes a second
--     invoice. claimed_at is the claim a try takes; once NetSuite made the
--     invoice its id and number are kept, and a refused try keeps NetSuite's
--     reason and lets go of the claim;
--   * gl_own_invoices.made_from takes 'typed', so Books keeps its own copy of
--     these invoices as it does of the other five ways of invoicing.
--
-- Writer and reader of typed_invoices: the service role only.

CREATE TABLE IF NOT EXISTS typed_invoices (
  id UUID PRIMARY KEY,
  customer_netsuite_id TEXT NOT NULL CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT,
  po_number TEXT,
  memo TEXT,
  vin TEXT,
  -- The lines as sent: [{ itemId, itemNumber, description, quantity, price, discount, taxable }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT,
  claimed_at TIMESTAMPTZ,
  netsuite_invoice_id TEXT,
  netsuite_invoice_number TEXT,
  error TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS typed_invoices_created_at_idx ON typed_invoices (created_at DESC);

ALTER TABLE gl_own_invoices DROP CONSTRAINT IF EXISTS gl_own_invoices_made_from_check;
ALTER TABLE gl_own_invoices ADD CONSTRAINT gl_own_invoices_made_from_check
  CHECK (made_from IN ('vehicle', 'sales_order', 'po', 'scans', 'graphics', 'typed'));

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  ALTER TABLE typed_invoices ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE typed_invoices FROM %I', r);
    END IF;
  END LOOP;
END $$;
