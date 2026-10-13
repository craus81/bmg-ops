-- Customer hold for past-due accounts (Valarie's ask, owner decisions
-- 2026-10-13).
--
-- A customer with any invoice 60+ days past due (ar_reminder_settings.hold_days)
-- goes On hold: a red flag on the customer record, in search and pickers, on
-- estimates and on the Past Due page. While on hold, sending an estimate or
-- wrap quote and creating a sales order are blocked until an admin or an A/R
-- contact overrides with a reason (logged in customer_hold_overrides, and the
-- A/R contacts are told). The sales rep and the A/R contacts are notified when
-- a customer goes on hold or comes off it.
--
-- customer_holds — one row per NetSuite customer the sweep or a person has
-- touched. auto_hold is the sweep's verdict (/api/cron/ar-past-due, weekdays
-- 7 AM); manual is a person's override: 'hold' forces the hold, 'release'
-- keeps the customer off hold whatever the sweep says (payment plan, trusted
-- account). On hold = manual = 'hold' OR (auto_hold AND manual IS NULL).
-- Keyed on the NetSuite id because past-due status comes from NetSuite;
-- customer_id (local customers.id) is kept alongside for screens that only
-- hold that.
--
-- Staff read both tables; writes go through the service role (API routes).

ALTER TABLE ar_reminder_settings ADD COLUMN IF NOT EXISTS hold_days INTEGER NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS customer_holds (
  netsuite_customer_id TEXT PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT,
  auto_hold BOOLEAN NOT NULL DEFAULT false,
  auto_since TIMESTAMPTZ,
  oldest_days INTEGER,
  past_due_amount NUMERIC(12, 2),
  manual TEXT CHECK (manual IN ('hold', 'release')),
  manual_note TEXT,
  manual_by UUID REFERENCES profiles(id),
  manual_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_holds_customer_idx ON customer_holds (customer_id);

CREATE TABLE IF NOT EXISTS customer_hold_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  netsuite_customer_id TEXT NOT NULL,
  customer_name TEXT,
  -- 'estimate_send' | 'wrap_quote_send' | 'sales_order'
  action TEXT NOT NULL,
  record_id TEXT,
  reason TEXT NOT NULL,
  user_id UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS customer_hold_overrides_customer_idx ON customer_hold_overrides (netsuite_customer_id, created_at DESC);

ALTER TABLE customer_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_hold_overrides ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Staff can read customer holds' AND tablename = 'customer_holds'
  ) THEN
    CREATE POLICY "Staff can read customer holds" ON customer_holds
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Staff can read customer hold overrides' AND tablename = 'customer_hold_overrides'
  ) THEN
    CREATE POLICY "Staff can read customer hold overrides" ON customer_hold_overrides
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
