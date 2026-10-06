-- Migration 343: camera installs (owner ask 2026-10-06).
--
-- Telematics camera installs (Surfsight camera + Geotab GO9B) done in the
-- shop for T-Mobile programs are their own process: no sales order, no
-- check-in, no upfit flow. A shop tech opens Camera Installs, picks the
-- customer, scans the VIN, the camera IMEI and the GO9B IMEI off their
-- barcodes, types the odometer and plate, and saves. Each row is one
-- vehicle's install; the page prints it as the filled-in install form (PDF)
-- and exports CSV.
--
-- checkin_id links to the vehicle's FleetSuite record when the VIN was
-- already checked in; it is informational only (nothing else reads it).
-- No RLS policies: service role only, behind requireStaff in
-- /api/camera-installs.

CREATE TABLE IF NOT EXISTS camera_installs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  vin VARCHAR(17) NOT NULL,
  vehicle_year TEXT,
  vehicle_make TEXT,
  vehicle_model TEXT,
  odometer INTEGER CHECK (odometer IS NULL OR odometer >= 0),
  license_plate TEXT,
  camera_imei TEXT NOT NULL,
  go9b_imei TEXT NOT NULL,
  checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL,
  notes TEXT,
  installed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS camera_installs_installed_at_idx ON camera_installs (installed_at DESC, id);
CREATE INDEX IF NOT EXISTS camera_installs_vin_idx ON camera_installs (vin);
CREATE INDEX IF NOT EXISTS camera_installs_customer_idx ON camera_installs (customer_name);
CREATE INDEX IF NOT EXISTS camera_installs_camera_imei_idx ON camera_installs (camera_imei);
CREATE INDEX IF NOT EXISTS camera_installs_go9b_imei_idx ON camera_installs (go9b_imei);

ALTER TABLE camera_installs ENABLE ROW LEVEL SECURITY;
