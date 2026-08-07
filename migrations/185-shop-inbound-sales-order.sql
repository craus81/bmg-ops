-- Migration 185: let a Sales Order put a vehicle on the shop's Arriving board
-- (V1). Converting an approved estimate to an SO now drops a shop_inbound
-- "expected" row, alongside the graphics-job and upfit-project sources that
-- already feed the board.
--
-- Design note (why source_id stays a UUID): shop_inbound.source_id is UUID
-- NOT NULL, but a NetSuite SO id is a numeric string — so the row keys off
-- the FleetSuite estimate's UUID (one estimate → one SO → one arrival), and
-- the NetSuite SO id/number ride in their own columns. The VIN column is
-- here for when estimates carry a VIN (roadmap E1/K5) or the check-in fills
-- it; today it stays null and the row is identified by customer + SO number.

-- Extend the source_type allow-list (the original inline CHECK is named
-- shop_inbound_source_type_check by Postgres convention).
ALTER TABLE shop_inbound DROP CONSTRAINT IF EXISTS shop_inbound_source_type_check;
ALTER TABLE shop_inbound ADD CONSTRAINT shop_inbound_source_type_check
  CHECK (source_type IN ('graphics_job', 'upfit_project', 'manual', 'sales_order'));

ALTER TABLE shop_inbound
  ADD COLUMN IF NOT EXISTS netsuite_so_id TEXT,
  ADD COLUMN IF NOT EXISTS netsuite_so_number TEXT,
  ADD COLUMN IF NOT EXISTS vin TEXT;

COMMENT ON COLUMN shop_inbound.netsuite_so_id IS 'FleetSuite-owned. NetSuite Sales Order internal id for a sales_order-sourced row.';
COMMENT ON COLUMN shop_inbound.netsuite_so_number IS 'FleetSuite-owned. Human SO number (tranid) shown on the Arriving board.';
COMMENT ON COLUMN shop_inbound.vin IS 'FleetSuite-owned. VIN of the expected vehicle when known (null until estimates carry a VIN or the check-in fills it).';
