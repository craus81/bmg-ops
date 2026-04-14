-- Migration 068: Migrate archived scanned_vehicles data into scan_logs
-- This consolidates all vehicle scan history into scan_logs as the single source of truth.
-- Skips any VINs that already exist in scan_logs to avoid duplicates.

INSERT INTO scan_logs (
  vin,
  vehicle_year,
  vehicle_make,
  vehicle_model,
  vehicle_trim,
  body_class,
  part_number,
  billable_customer,
  location_name,
  po_line_item_id,
  scanned_by,
  scanned_at,
  exported_at
)
SELECT
  sv.vin,
  sv.vehicle_year,
  sv.vehicle_make,
  sv.vehicle_model,
  sv.vehicle_trim,
  sv.body_class,
  sv.part_number,
  sv.customer,                          -- maps to billable_customer
  sv.install_location,                  -- maps to location_name
  sv.po_line_item_id,
  sv.scanned_by,
  sv.scanned_at,
  sv.exported_at
FROM scanned_vehicles sv
WHERE NOT EXISTS (
  SELECT 1 FROM scan_logs sl
  WHERE sl.vin = sv.vin
  AND sl.part_number = sv.part_number
);

-- Backfill po_id and po_number from po_line_items for migrated records that have a po_line_item_id
UPDATE scan_logs sl
SET
  po_id = pli.po_id,
  po_number = po.po_number
FROM po_line_items pli
JOIN purchase_orders po ON po.id = pli.po_id
WHERE sl.po_line_item_id = pli.id
AND sl.po_id IS NULL;
