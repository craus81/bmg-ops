-- Add multi-role support and soft delete to profiles
-- Run in Supabase SQL Editor

-- Multi-role: array of roles a user has access to
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS roles TEXT[] DEFAULT '{}';

-- Soft delete: deactivated users can't log in
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deactivated BOOLEAN DEFAULT false;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deactivated_by UUID REFERENCES auth.users(id);

-- Backfill: copy existing role into roles array for all users
UPDATE profiles
SET roles = ARRAY[role]
WHERE roles = '{}' OR roles IS NULL;

-- Index for fast role lookups
CREATE INDEX IF NOT EXISTS idx_profiles_roles ON profiles USING GIN (roles);

-- Verify
SELECT id, full_name, role, roles, deactivated
FROM profiles
LIMIT 10;
