-- Migration 196: NetSuite sales orders mirrored locally (roadmap N3)
--
-- "Pull sales orders from NetSuite, link to estimates in FleetSuite." SOs
-- created directly in NetSuite were invisible here — estimates.netsuite_so_id
-- was written by exactly one push-side code path. This mirrors SO headers +
-- item lines (same shape as the vendor-PO mirror, migration 161) and records
-- how each SO was matched back to its estimate:
--
--   match_source: 'createdfrom'   transaction.createdfrom = the estimate's
--                                 NetSuite internal id (NetSuite-side
--                                 Estimate→SO transforms; FleetSuite-created
--                                 SOs are standalone today so this is rare
--                                 until convert-to-so adopts the transform)
--                 'otherrefnum'   Reference No. equals a FleetSuite estimate
--                                 number (convert-to-so writes it there) —
--                                 guarded to EST-* shapes so a customer PO
--                                 number in that free-text field can't
--                                 mis-attach an SO
--                 'memo'          "FleetSuite Estimate #X" in the SO memo —
--                                 recorded for review but NOT auto-written
--                                 onto the estimate (weakest signal)
--
-- Only createdfrom/otherrefnum matches backfill estimates.netsuite_so_id,
-- and only when the estimate doesn't already have one.

CREATE TABLE IF NOT EXISTS netsuite_sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  netsuite_id TEXT NOT NULL UNIQUE,   -- transaction internal id
  tranid TEXT,                        -- SO number as shown in NetSuite
  customer_netsuite_id TEXT,
  customer_name TEXT,
  trandate DATE,
  status TEXT,                        -- raw NetSuite status code
  status_label TEXT,                  -- display name when available
  memo TEXT,
  otherrefnum TEXT,                   -- Reference No. (customer PO or estimate #)
  createdfrom_netsuite_id TEXT,       -- source transaction (estimate) when transformed
  vin TEXT,                           -- custbody_vin_number_
  total NUMERIC(14,2),
  estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL,
  match_source TEXT CHECK (match_source IN ('createdfrom', 'otherrefnum', 'memo')),
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ns_sos_customer ON netsuite_sales_orders(customer_name);
CREATE INDEX IF NOT EXISTS idx_ns_sos_date ON netsuite_sales_orders(trandate DESC);
CREATE INDEX IF NOT EXISTS idx_ns_sos_estimate ON netsuite_sales_orders(estimate_id);

CREATE TABLE IF NOT EXISTS netsuite_sales_order_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  so_id UUID NOT NULL REFERENCES netsuite_sales_orders(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,              -- transactionline id within the SO
  item_netsuite_id TEXT,
  item_number TEXT,                   -- normalized (last ":" segment, uppercased)
  description TEXT,
  quantity NUMERIC(14,2) NOT NULL DEFAULT 0,
  quantity_billed NUMERIC(14,2) NOT NULL DEFAULT 0,
  rate NUMERIC(14,4),
  amount NUMERIC(14,2),
  UNIQUE (so_id, line_id)
);

CREATE INDEX IF NOT EXISTS idx_ns_so_lines_item ON netsuite_sales_order_lines(item_number);
CREATE INDEX IF NOT EXISTS idx_ns_so_lines_so ON netsuite_sales_order_lines(so_id);

-- Staff read; writes come from the sync (service role).
ALTER TABLE netsuite_sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE netsuite_sales_order_lines ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read sales orders' AND tablename = 'netsuite_sales_orders') THEN
    CREATE POLICY "Staff read sales orders" ON netsuite_sales_orders
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read sales order lines' AND tablename = 'netsuite_sales_order_lines') THEN
    CREATE POLICY "Staff read sales order lines" ON netsuite_sales_order_lines
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
