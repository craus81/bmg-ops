-- Free-text vehicle on estimates, for vehicles outside vehicle_platforms
-- (field ask 2026-08-21: "I want any vehicle to be able to be selected...
-- we should be able to type in a vehicle"). Used when no platform matches:
-- a VIN decode auto-fills it, or staff type it by hand. Null whenever a
-- platform is selected — the platform stays the fitment source of truth.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_other text;
