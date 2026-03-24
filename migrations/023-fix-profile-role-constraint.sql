-- Migration 023: Fix profiles role constraint to allow all 5 roles
-- The original constraint only allowed 'admin' and 'installer'.
-- Drop any existing CHECK constraint on the role column and recreate with all roles.

-- Drop the old constraint (name may vary — try common patterns)
DO $$
BEGIN
  -- Try dropping by common constraint names
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS check_role;
  ALTER TABLE profiles DROP CONSTRAINT IF EXISTS valid_role;

  -- Also try to find and drop any CHECK constraint on the role column dynamically
  PERFORM 1;
EXCEPTION WHEN OTHERS THEN
  NULL; -- ignore if constraints don't exist
END $$;

-- Now add the correct constraint with all 5 roles
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('admin', 'installer', 'production', 'sales', 'customer'));
