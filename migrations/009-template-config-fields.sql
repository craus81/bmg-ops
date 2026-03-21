-- Add vehicle configuration fields to templates
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS doors TEXT;
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS roof_height TEXT;
ALTER TABLE vehicle_templates ADD COLUMN IF NOT EXISTS windows TEXT;
