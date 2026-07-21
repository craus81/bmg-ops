-- Migration 169: super_admin role
-- A tier above admin for the owner: User Management, Audit Log, System
-- Health, AI Instructions, and Knowledge Base become super-admin-only
-- features (src/lib/features.ts) — regular admins keep everything else,
-- and individual admins can still be granted those pages back via the
-- existing per-user feature overrides.
--
-- super_admin lives in the roles ARRAY alongside admin; the scalar `role`
-- column stays 'admin' so every existing RLS policy keyed on role='admin'
-- keeps working. The CHECK constraint is widened anyway so a future write
-- can't be rejected ('finance' was also missing — migration 145 predates
-- that role).

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'super_admin', 'installer', 'field_tech', 'shop_tech',
    'sales', 'graphics_production', 'customer', 'production', 'finance'
  ));

-- Seed: the owner is the first (and initially only) super admin.
UPDATE profiles
SET roles = array_append(
      COALESCE(NULLIF(roles, '{}'::text[]), ARRAY[COALESCE(role, 'admin')]),
      'super_admin'
    )
WHERE lower(email) = 'cgeorge@bmgfleet.com'
  AND NOT ('super_admin' = ANY(COALESCE(roles, '{}'::text[])));
