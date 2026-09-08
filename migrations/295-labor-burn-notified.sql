-- Migration 295: labor burn meter (R6-12)
--
-- The pick-list already shows hours logged against a vehicle; it has never
-- shown them against the hours that were SOLD, so a job runs past its
-- quoted labor with nobody finding out until the margin report months
-- later. The meter compares the two where the work happens, and pings the
-- assignee + admins the first time a vehicle crosses 100%.
--
-- ONE ping per visit is the whole point: a stamp, not a counter. A vehicle
-- that crosses, gets pushed back under by an estimate revision, and crosses
-- again is the same conversation — nagging a tech every time a timer stops
-- would train them to ignore it. Nothing needs clearing on a re-check-in: a
-- returning vehicle gets a NEW fleet_checkins row, so the new visit starts
-- with a null stamp and gets its own single ping.
ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS labor_burn_notified_at TIMESTAMPTZ;

COMMENT ON COLUMN fleet_checkins.labor_burn_notified_at IS
  'Migration 295: set the first time logged shop hours reach the sold labor hours on this visit, so the over-budget ping fires exactly once. A returning vehicle gets a new row, hence a new ping.';
