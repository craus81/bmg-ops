-- Add archived_at column to fleet_checkins for archiving vehicles
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_fleet_checkins_archived ON fleet_checkins(archived_at);
