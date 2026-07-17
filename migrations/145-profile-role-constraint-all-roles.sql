-- The profiles_role_check constraint (last set in migration 023) only allows
-- the original 5 roles: admin, installer, production, sales, customer. The app
-- has since added graphics_production, shop_tech, and field_tech, so any write
-- that sets the scalar `role` column to one of those is rejected — e.g.
-- removing the installer role from someone who also has field_tech, which
-- promotes field_tech to the primary role.
--
-- Recreate the constraint with every role the app uses. 'production' is kept
-- for backward compatibility with any legacy rows that still carry it.
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'installer', 'field_tech', 'shop_tech',
    'sales', 'graphics_production', 'customer', 'production'
  ));
