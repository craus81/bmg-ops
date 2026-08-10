-- Migration 189: VIN (+ unit number) on estimates (K5)
--
-- The Aug 6 meeting decided VINs are captured on the ESTIMATE (not typed
-- later on the NetSuite SO): the field prints on the customer-facing
-- estimate document, pushes to NetSuite's custbody_vin_number_ on both
-- estimate push and convert-to-SO, and feeds the Shop Board's "arriving"
-- row (shop_inbound.vin) so V1 no longer depends on NetSuite data hygiene.
--
-- One header VIN per estimate for now — per-line VINs only if asked
-- (docs/fleetsuite-plan-2026-08-06.md K5).

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS vin TEXT,
  ADD COLUMN IF NOT EXISTS unit_number TEXT;

COMMENT ON COLUMN estimates.vin IS
  'Vehicle VIN (full 17 or partial). Uppercased on save. Prints on the estimate document; pushed to NetSuite custbody_vin_number_ on estimate push and convert-to-SO; copied to shop_inbound.vin for the Arriving board.';
COMMENT ON COLUMN estimates.unit_number IS
  'Customer fleet unit number for the vehicle. Shown on the estimate document and carried into the SO memo.';
