-- Migration 520: sales orders "To print" for the board, and End user.
--
-- Craig, 2026-11-04 (thread "Print new sales orders for the board"): every
-- new sales order is printed and hung on the board so Harold can see
-- what's going on. Picks: a "To print" list for Jessie that fills by
-- itself when a sales order is created, a bell + push to her for each one
-- (Craig copied), and a printed order goes back on the list when it
-- changes or a vendor PO is added for the vehicle (auto-print to the
-- Ricoh may come later). Also an End user on estimates and sales orders:
-- the company the work is for when someone else is billed ("billing
-- Clement Ford but the end user is Jerry Kelly"), kept in NetSuite in the
-- body field custbody_vehicle_info_ (src/lib/end-user.ts).

-- ── End user ──────────────────────────────────────────────────────────
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS end_user TEXT;
COMMENT ON COLUMN estimates.end_user IS
  'Company the work is for when someone else is billed; goes to the sales order (NetSuite custbody_vehicle_info_).';

ALTER TABLE netsuite_sales_orders ADD COLUMN IF NOT EXISTS end_user TEXT;
COMMENT ON COLUMN netsuite_sales_orders.end_user IS
  'Mirror of NetSuite custbody_vehicle_info_ (End user).';

-- ── Who prints sales orders ───────────────────────────────────────────
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS prints_sales_orders BOOLEAN DEFAULT false;
COMMENT ON COLUMN notification_preferences.prints_sales_orders IS
  'This person prints sales orders for the board: gets the "Sales order to print" alert.';

-- ── The list ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS so_print_queue (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  so_netsuite_id TEXT NOT NULL UNIQUE,
  so_number TEXT,
  customer_name TEXT,
  end_user TEXT,
  status TEXT NOT NULL DEFAULT 'to_print' CHECK (status IN ('to_print', 'printed')),
  -- Why it is (back) on the list: new order, the order changed, or a
  -- vendor PO was added for its vehicle.
  reason TEXT NOT NULL DEFAULT 'new' CHECK (reason IN ('new', 'changed', 'new_po')),
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  printed_at TIMESTAMPTZ,
  printed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_so_print_queue_status ON so_print_queue(status, queued_at DESC);

-- Staff read; writes go through the API on the service role.
ALTER TABLE so_print_queue ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read print queue' AND tablename = 'so_print_queue') THEN
    CREATE POLICY "Staff read print queue" ON so_print_queue
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;

-- Tick it for Jessie, only when exactly one approved Jessie exists (same
-- guard as migration 430). Changeable in Admin → Users → Settings.
DO $$
DECLARE
  jessie UUID;
  n INT;
BEGIN
  SELECT count(*) INTO n FROM profiles
   WHERE full_name ILIKE 'Jessie %' AND status = 'approved';
  IF n = 1 THEN
    SELECT id INTO jessie FROM profiles
     WHERE full_name ILIKE 'Jessie %' AND status = 'approved';
    IF EXISTS (SELECT 1 FROM notification_preferences WHERE user_id = jessie) THEN
      UPDATE notification_preferences SET prints_sales_orders = true WHERE user_id = jessie;
    ELSE
      INSERT INTO notification_preferences (user_id, prints_sales_orders) VALUES (jessie, true);
    END IF;
  END IF;
END $$;
