-- Migration 059: Prospect/Customer unification + new fields

-- Lead source for tracking how prospects come in
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS lead_source TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS lead_source_other TEXT;

-- Multi-location flag
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS multi_location BOOLEAN DEFAULT false;

-- Email campaign opt-in
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS email_campaign BOOLEAN DEFAULT false;

-- Hot prospect flag
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS is_hot BOOLEAN DEFAULT false;

-- Phone (may already exist on some records via contact_name flow)
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS phone TEXT;

-- Address fields (some may already exist)
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS zip TEXT;

-- Remove status options we don't need (lost, inactive)
-- Update existing records
UPDATE prospects SET status = 'active' WHERE status IN ('lost', 'inactive');

-- Update check constraint
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_status_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_status_check CHECK (status IN ('active', 'nurturing', 'converted'));

-- Drop cadence tables (replaced by note reminders)
DROP TABLE IF EXISTS prospect_cadence_assignments;
DROP TABLE IF EXISTS sales_cadences;
