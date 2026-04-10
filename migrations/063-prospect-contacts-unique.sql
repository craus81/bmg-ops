-- Migration 063: Unique constraint on prospect_contacts for NetSuite sync upsert
-- Also add created_at index for contact display ordering

ALTER TABLE prospect_contacts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

-- Add unique constraint on prospect_id + name for upsert
ALTER TABLE prospect_contacts ADD CONSTRAINT prospect_contacts_prospect_name_unique UNIQUE (prospect_id, name);
