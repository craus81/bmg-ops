-- Migration 338: remember when a vehicle's sales orders were scanned for
-- graphics lines (owner ask 2026-10-05).
--
-- The one-line status row shows the Graphics buttons when the vehicle has a
-- graphics job OR its NetSuite sales order / estimate has graphics lines
-- (graphics_signal, set by the check-in scan since migration 101). That scan
-- used to run only at check-in, so an SO linked afterwards was never read.
-- Linking an SO, or opening a vehicle that was never scanned, now scans it;
-- this stamp keeps a vehicle with no graphics lines from being re-scanned
-- every time it is opened.
ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS graphics_scanned_at TIMESTAMPTZ;
