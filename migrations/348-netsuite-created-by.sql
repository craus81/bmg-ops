-- Migration 348: who created each NetSuite sales order and PO (owner ask
-- 2026-10-07: a "Created by" tag on every transaction).
--
-- FleetSuite-made records already carry a creator (created_by,
-- requested_by, checked_in_by …). The NetSuite mirrors don't: SOs and POs
-- are made in NetSuite and synced in. The netsuite-sync cron now reads
-- NetSuite's own Created By (transaction.createdby, as the employee's
-- display name) for rows it hasn't checked yet and stamps
-- creator_checked_at either way, so each record is looked up once and
-- older records backfill a batch at a time.

ALTER TABLE netsuite_sales_orders
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS creator_checked_at TIMESTAMPTZ;

ALTER TABLE netsuite_vendor_pos
  ADD COLUMN IF NOT EXISTS created_by_name TEXT,
  ADD COLUMN IF NOT EXISTS creator_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_netsuite_sales_orders_creator_unchecked
  ON netsuite_sales_orders (netsuite_id) WHERE creator_checked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_netsuite_vendor_pos_creator_unchecked
  ON netsuite_vendor_pos (netsuite_id) WHERE creator_checked_at IS NULL;
