-- Migration 261: one invoice PER sales order on a vehicle (§7.4 item 2)
--
-- THE TRAP: the completion modal renders an "Invoice SO …" button for every
-- sales order linked to a check-in, but the check-in stores exactly one
-- scalar invoice_number and the invoice route 409s on any second attempt —
-- so a three-SO vehicle can bill exactly one of them, behind a UI offering
-- all three.
--
-- THE FIX: a per-(check-in, sales order) invoice ledger. The UNIQUE pair is
-- the idempotence key: the route INSERTS the row as its claim BEFORE
-- calling NetSuite (a concurrent second click hits the unique violation and
-- turns away), retires the claim by stamping the invoice fields, and
-- deletes its own still-unstamped row on failure. A claimed row older than
-- 15 minutes with no invoice is stale and can be taken over.
--
-- The legacy scalar fleet_checkins.invoice_number keeps being stamped for a
-- check-in's FIRST invoice (the archived card, unpaid tile, and AR payment
-- sync all read it); this table is the authoritative per-SO record.

CREATE TABLE IF NOT EXISTS fleet_checkin_invoices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  fleet_checkin_id UUID NOT NULL REFERENCES fleet_checkins(id) ON DELETE CASCADE,
  netsuite_sales_order_id TEXT NOT NULL,
  invoice_number TEXT,
  netsuite_invoice_id TEXT,
  fulfillment_number TEXT,
  claimed_at TIMESTAMPTZ,
  invoiced_at TIMESTAMPTZ,
  invoiced_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (fleet_checkin_id, netsuite_sales_order_id)
);

CREATE INDEX IF NOT EXISTS idx_fleet_checkin_invoices_checkin
  ON fleet_checkin_invoices(fleet_checkin_id);

COMMENT ON TABLE fleet_checkin_invoices IS
  'Migration 261: per-sales-order invoice ledger for a vehicle check-in. A row is inserted as the atomic claim before the NetSuite invoice is created (UNIQUE (fleet_checkin_id, netsuite_sales_order_id) turns a concurrent second attempt away), stamped with the invoice on success, and deleted on failure. claimed_at older than 15 minutes with no invoice_number is stale and reclaimable.';

ALTER TABLE fleet_checkin_invoices ENABLE ROW LEVEL SECURITY;

-- Staff can read the ledger; every write goes through the service-role
-- invoice route (no client INSERT/UPDATE/DELETE policies on purpose).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkin_invoices'
      AND policyname = 'fleet_checkin_invoices_staff_select'
  ) THEN
    CREATE POLICY fleet_checkin_invoices_staff_select ON fleet_checkin_invoices
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;
