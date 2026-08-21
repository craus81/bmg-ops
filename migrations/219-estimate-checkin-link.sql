-- Estimate ↔ checked-in vehicle link (field ask, 2026-08-21: "I created an
-- estimate for a vehicle that has already been checked in — let's make a
-- button that can link the two together").
--
-- The estimate builder gains a Link Checked-In Vehicle button (with a VIN
-- auto-suggest) that stores the fleet_checkins row here and shows a chip
-- deep-linking the In-Shop board; the tracking page's vehicle detail shows
-- the estimates linked back. Complements fleet_checkins.source_estimate_id
-- (080), which points the other way and is only stamped at check-in time.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS fleet_checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL;

-- The tracking page looks estimates up by check-in when a vehicle expands.
CREATE INDEX IF NOT EXISTS idx_estimates_fleet_checkin
  ON estimates(fleet_checkin_id)
  WHERE fleet_checkin_id IS NOT NULL;
