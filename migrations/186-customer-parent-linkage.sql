-- Migration 186: Customer parent / leasing-company linkage (K1 — Aug 6
-- session plan, docs/fleetsuite-plan-2026-08-06.md).
--
-- Two kinds of parent, deliberately separate:
--   * netsuite_parent_id — NS-SOURCED. Raw NetSuite internal id from
--     customer.parent, written by both sync paths (hourly cron + manual
--     full sync). Resolved to a local customer at read time via the
--     netsuite_id join.
--   * parent_customer_id / parent_source — FleetSuite-OWNED, written only
--     by the "Assign to leasing company" control. Like the migration-080
--     columns, these are never in the sync upsert's SET list, so a manual
--     link survives resync. When both exist, the manual link wins.
--
-- Re-parenting is audited: the assign API requires a note and logs it to
-- prospect_activities via the netsuite_id join (the meeting: "notes should
-- be used to explain account status changes when customers move between
-- parent and sub-accounts").

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS netsuite_parent_id TEXT,
  ADD COLUMN IF NOT EXISTS parent_customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS parent_source TEXT CHECK (parent_source IN ('netsuite', 'manual'));

COMMENT ON COLUMN customers.netsuite_parent_id IS 'NS-sourced. NetSuite internal id of customer.parent; resolved to a local customer via netsuite_id at read time.';
COMMENT ON COLUMN customers.parent_customer_id IS 'FleetSuite-owned. Manually assigned parent (leasing company / parent account); wins over netsuite_parent_id. Survives resync.';
COMMENT ON COLUMN customers.parent_source IS 'FleetSuite-owned. Where parent_customer_id came from (''manual'' from the assign control; ''netsuite'' reserved for materialized NS links).';

CREATE INDEX IF NOT EXISTS idx_customers_netsuite_parent
  ON customers(netsuite_parent_id) WHERE netsuite_parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_parent
  ON customers(parent_customer_id) WHERE parent_customer_id IS NOT NULL;
