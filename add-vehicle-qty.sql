-- Add vehicle_qty column to quotes table for multi-vehicle quoting
-- This stores the number of vehicles being quoted (default 1 for existing quotes)

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS vehicle_qty integer NOT NULL DEFAULT 1;
