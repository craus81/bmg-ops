-- Migration 094: flag check-ins whose linked SO/estimate calls for graphics
--
-- Set at check-in save time from a keyword scan of the linked SO line items
-- and any source estimate's line items. UI surfaces (inline prompt after
-- check-in, In-Shop chip, /graphics queue tab) read these columns; they
-- never recompute on render.

ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS needs_graphics BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS graphics_signal TEXT;

-- Partial index: the queue view filters `needs_graphics = true AND
-- matched_graphics_job_id IS NULL`, which is a tiny subset of the table.
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_needs_graphics
  ON fleet_checkins(needs_graphics)
  WHERE needs_graphics = TRUE;
