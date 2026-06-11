-- Analytics support: add rework tracking to scanned_vehicles
-- Run this in Supabase SQL Editor

-- Add denial_count to track rework/redo stats
ALTER TABLE scanned_vehicles ADD COLUMN IF NOT EXISTS denial_count integer DEFAULT 0;

-- Add location (text) to scanned_vehicles so we can track where installs happen
-- This can be set from the schedule or manually
ALTER TABLE scanned_vehicles ADD COLUMN IF NOT EXISTS install_location text;

-- Backfill denial_count for any already-denied vehicles
UPDATE scanned_vehicles SET denial_count = 1 WHERE review_status = 'denied' AND denial_count = 0;

-- Verify
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'scanned_vehicles' AND column_name IN ('denial_count', 'install_location');
