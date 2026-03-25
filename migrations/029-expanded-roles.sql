-- Migration 029: Expanded role system
-- New roles: field_tech, shop_tech, graphics_production
-- Legacy 'production' role maps to 'graphics_production'
-- 'installer' remains as pre-approval default signup role

-- No schema changes needed — roles are stored as TEXT/TEXT[] and
-- the app handles mapping. This migration is documentation + optional
-- data migration for existing 'production' users.

-- Migrate existing 'production' users to 'graphics_production'
UPDATE profiles
SET role = 'graphics_production'
WHERE role = 'production';

-- Update the roles[] array for anyone who has 'production' in it
UPDATE profiles
SET roles = array_replace(roles, 'production', 'graphics_production')
WHERE 'production' = ANY(roles);

-- Update RLS helper function to recognize new roles as internal staff
CREATE OR REPLACE FUNCTION is_internal_staff()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
    AND role IN ('admin', 'graphics_production', 'production', 'sales', 'field_tech', 'shop_tech', 'installer')
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Add comment documenting the role structure
COMMENT ON COLUMN profiles.role IS 'Primary role: admin, installer, field_tech, shop_tech, sales, graphics_production, customer';
COMMENT ON COLUMN profiles.roles IS 'Multi-role array. Legacy "production" maps to "graphics_production" in app code.';
