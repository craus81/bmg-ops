-- Migration 483: the bookkeeper and CPA roles, which open FleetSuite's own books
--
-- Books part 52 (docs/books.md "Who can open the books"). Until now only super
-- admins could open the books. Two roles join them there, each its own login
-- that isn't BMG staff, like executive (migration 176):
--   * bookkeeper — does the books: copies and posts, closes months, clears
--     mistake checks, snaps bills, uploads NetSuite's 1099 report. The steps
--     only the owner takes (the switches, going live, keeping or taking a
--     change made in NetSuite, reopening a closed month) stay super admins'.
--   * cpa — reads every Books page and changes nothing.
-- What each can do is src/lib/books/access.ts, enforced by requireBooks
-- (src/lib/api-auth.ts) on every Books route. Neither is in is_internal_staff()
-- (migration 224) or INTERNAL_STAFF_ROLES, so the rest of the app's data stays
-- closed to them; stack another role on a person who needs more.
--
-- Two changes here:
--   1. profiles_role_check widened so the scalar `role` can be either.
--   2. guard_profile_privilege_columns (migration 233) replaced, the same
--      function with two additions:
--        * bookkeeper and cpa join privileged_roles, so a self-created
--          profile can't start with one;
--        * only a super admin gives out the owner-level roles: super_admin,
--          bookkeeper and cpa. Until now any admin could put any role on
--          anyone at the database, though create-user already refused a
--          super admin minted by an admin and only super admins open the
--          Users page. An admin who isn't a super admin may still take one
--          away, and may still change everything else on a profile that has
--          one.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'admin', 'super_admin', 'executive', 'installer', 'field_tech', 'shop_tech',
    'sales', 'graphics_production', 'customer', 'production', 'finance',
    'bookkeeper', 'cpa'
  ));

CREATE OR REPLACE FUNCTION public.guard_profile_privilege_columns()
RETURNS TRIGGER AS $$
DECLARE
  guarded_cols text[] := ARRAY[
    'role', 'roles', 'status',
    'deactivated', 'deactivated_at', 'deactivated_by',
    'company_id', 'customer_netsuite_id', 'is_field_installer'
  ];
  -- The staff allowlist from migration 224:42-51, plus executive and the
  -- books' bookkeeper and cpa: the roles that grant access beyond an
  -- installer/customer login.
  privileged_roles text[] := ARRAY[
    'admin', 'super_admin', 'sales', 'graphics_production', 'production',
    'shop_tech', 'field_tech', 'finance', 'executive', 'bookkeeper', 'cpa'
  ];
  -- Roles only a super admin gives out (migration 483).
  owner_given_roles text[] := ARRAY['super_admin', 'bookkeeper', 'cpa'];
  col text;
  old_row jsonb;
  new_row jsonb := to_jsonb(NEW);
BEGIN
  -- Service role / SECURITY DEFINER contexts carry no end-user identity.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Admins and owners manage other people's access for a living; an admin
  -- who isn't a super admin can't give out an owner-level role.
  IF public.get_my_roles() && ARRAY['admin', 'super_admin'] THEN
    IF NOT (public.get_my_roles() && ARRAY['super_admin']) THEN
      old_row := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
      FOREACH col IN ARRAY owner_given_roles LOOP
        IF (COALESCE((new_row ->> 'role') = col, false) OR COALESCE((new_row -> 'roles') ? col, false))
           AND NOT (COALESCE((old_row ->> 'role') = col, false) OR COALESCE((old_row -> 'roles') ? col, false)) THEN
          RAISE EXCEPTION
            'permission denied: only a super admin can give the % role', col
            USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
    FOREACH col IN ARRAY guarded_cols LOOP
      IF (new_row ? col) AND (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
        RAISE EXCEPTION
          'permission denied: profiles.% is not self-editable', col
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- INSERT: a self-created row may only start from unprivileged values.
  -- (No browser code inserts profiles today — signup runs service-role — so
  -- this only ever fires on a hand-rolled request.) Test for privileged
  -- VALUES, never mere presence: several of these columns carry defaults
  -- (deactivated, is_field_installer are DEFAULT false), so a presence check
  -- would reject an ordinary insert that never asked for anything.
  IF NEW.id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION
      'permission denied: cannot create a profile for another account'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(new_row ->> 'status', 'pending') <> 'pending' THEN
    RAISE EXCEPTION
      'permission denied: a new profile may only be created as pending'
      USING ERRCODE = '42501';
  END IF;

  IF (new_row ->> 'role') = ANY (privileged_roles) THEN
    RAISE EXCEPTION
      'permission denied: profiles.role may not be self-assigned to %', new_row ->> 'role'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(new_row -> 'roles') = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements_text(new_row -> 'roles') AS r(v)
       WHERE r.v = ANY (privileged_roles)
     ) THEN
    RAISE EXCEPTION
      'permission denied: profiles.roles may not be self-assigned a privileged role'
      USING ERRCODE = '42501';
  END IF;

  IF (new_row ->> 'deactivated') = 'true' OR (new_row ->> 'is_field_installer') = 'true' THEN
    RAISE EXCEPTION
      'permission denied: that profile flag is not self-assignable'
      USING ERRCODE = '42501';
  END IF;

  FOREACH col IN ARRAY ARRAY['company_id', 'customer_netsuite_id', 'deactivated_at', 'deactivated_by'] LOOP
    IF (new_row ? col) AND jsonb_typeof(new_row -> col) <> 'null' THEN
      RAISE EXCEPTION
        'permission denied: profiles.% is not self-assignable', col
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

COMMENT ON FUNCTION public.guard_profile_privilege_columns() IS
  'Migrations 233 and 483: blocks self-service privilege escalation. A signed-in non-admin cannot change role, roles, status, deactivated*, company_id, customer_netsuite_id or is_field_installer on their own profile row. Only a super admin gives out super_admin, bookkeeper or cpa. Service-role callers (auth.uid() IS NULL) are exempt.';
