-- Migration 176: executive role
-- A lean leadership role (e.g. for the owner-adjacent execs) that sees the
-- Home dashboard's new Financials tab — A/R aging, A/P, cash, and net
-- position — and nothing else: no settings, user management, or ops tooling.
-- Feature access is defined in src/lib/features.ts (the `financials` feature
-- is super-admin/executive only; regular admins do NOT get it).
--
-- Unlike super_admin, executive is a standalone role (not stacked on admin),
-- so it carries none of admin's RLS grants — the Financials data is served by
-- an API route that authorizes super_admin/executive explicitly, not via RLS.
-- The CHECK constraint is widened so the scalar `role` can be 'executive'.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'super_admin', 'executive', 'installer', 'field_tech', 'shop_tech',
    'sales', 'graphics_production', 'customer', 'production', 'finance'
  ));
