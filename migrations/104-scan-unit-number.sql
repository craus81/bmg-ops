-- Migration 097: Unit number on scan logs
-- Lets installers tag a scanned VIN with the customer's unit/fleet number
-- so it's logged alongside the VIN (live scan screen + worksheet import).
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS unit_number TEXT;
