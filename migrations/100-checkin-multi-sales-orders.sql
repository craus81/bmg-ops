-- Migration 093: Multiple sales orders per vehicle check-in
--
-- Until now a fleet_checkin stored its NetSuite sales order in flat
-- columns (netsuite_sales_order_id, sales_order_number, ...), which
-- limited each vehicle to a single linked SO. Some upfits ship against
-- multiple SOs, so we add a join table that can hold many SO refs per
-- check-in. The legacy columns are kept in sync (mirroring the oldest
-- linked SO) so all the existing readers — pick lists, universal
-- search, fleet page, installer API, etc. — keep working without
-- changes.

CREATE TABLE IF NOT EXISTS fleet_checkin_sales_orders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  checkin_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  netsuite_sales_order_id VARCHAR(50) NOT NULL,
  sales_order_number VARCHAR(50),
  customer_name VARCHAR(255),
  sales_order_memo TEXT,
  sales_order_total DECIMAL(12,2),
  added_by UUID REFERENCES auth.users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (checkin_id, netsuite_sales_order_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_checkin_sos_checkin
  ON fleet_checkin_sales_orders(checkin_id, added_at);

CREATE INDEX IF NOT EXISTS idx_fleet_checkin_sos_so
  ON fleet_checkin_sales_orders(netsuite_sales_order_id);

-- Backfill: every check-in that already has a linked SO gets a row in
-- the join table so the new code reads a consistent view.
INSERT INTO fleet_checkin_sales_orders (
  checkin_id, netsuite_sales_order_id, sales_order_number,
  customer_name, sales_order_memo, sales_order_total, added_at
)
SELECT
  id, netsuite_sales_order_id, sales_order_number,
  customer_name, sales_order_memo, sales_order_total,
  COALESCE(updated_at, created_at, NOW())
FROM fleet_checkins
WHERE netsuite_sales_order_id IS NOT NULL
ON CONFLICT (checkin_id, netsuite_sales_order_id) DO NOTHING;

ALTER TABLE fleet_checkin_sales_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage checkin sales orders"
  ON fleet_checkin_sales_orders FOR ALL
  TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
