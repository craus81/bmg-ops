-- Migration 233: stop an account from granting itself privileges
--
-- THE HOLE (verified at 0c48f1f, not previously in the audit):
-- `profiles_update_own` (migrations/027-enable-rls-all-tables.sql:99-102) is
--   FOR UPDATE TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid())
-- RLS cannot scope columns, no column-level GRANTs exist in any of the 232
-- migrations, and no trigger guards the table. So ANY authenticated account —
-- customer portal logins and external CNI installers included — can run one
-- statement against the browser's anon-key client:
--     supabase.from('profiles')
--       .update({ role: 'super_admin', roles: ['super_admin'], status: 'approved' })
--       .eq('id', <their own id>)
-- and become a super_admin. Both layers of authorization read exactly those
-- columns back: the server via profileRoles() (src/lib/api-auth.ts:87-89) and
-- RLS via get_my_roles() (027:58-66) feeding is_admin()/is_internal_staff().
-- `profiles_insert WITH CHECK (true)` (027:96-97) is the same hole for anyone
-- who has an auth.users row but no profile row yet, and additionally lets one
-- account create a row for somebody else's uuid.
--
-- THE FIX: a BEFORE INSERT OR UPDATE trigger that refuses to let a normal
-- signed-in user change the privilege-bearing columns, plus a tightened INSERT
-- policy. Deliberately a DENYLIST of privileged columns rather than an
-- allowlist of safe ones (or column GRANTs): an allowlist silently breaks the
-- next benign column someone adds, and the only legitimate browser self-edit
-- today is the email signature at src/app/(main)/settings/page.tsx:64-67.
--
-- Columns are compared through to_jsonb(OLD)/to_jsonb(NEW) rather than named
-- with NEW.<col>, so a guarded column that does not exist in a given database
-- is simply absent from the map instead of raising at runtime. This database
-- is known to drift from the migration files (see the 230 incident recorded in
-- docs/workflow-audit-2026-08.md), so naming columns directly is a real risk.
--
-- WHO IS EXEMPT, and why nothing legitimate breaks:
--   * auth.uid() IS NULL — every service-role API route (signup, admin
--     create-user, CNI invite, user-settings) and SECURITY DEFINER functions
--     such as handle_new_user(). Service role bypasses RLS but NOT triggers,
--     so this exemption is what keeps those paths working.
--   * admin / super_admin callers — the admin UI edits other people's roles
--     through profiles_update_admin (027:104-107). is_admin() alone is not
--     used here: it tests only for the literal 'admin' role (027:69-72), so a
--     pure super_admin would otherwise be locked out of the admin screens.
--
-- Residual, deliberately not widened here: is_admin()/get_my_roles() ignore
-- status and deactivated, so a deactivated admin still passes this guard. That
-- is true of every is_admin() policy in the schema; requireAuth blocks those
-- accounts at the API layer (src/lib/api-auth.ts, #631). Changing the shared
-- admin test belongs in its own migration, not this one.

CREATE OR REPLACE FUNCTION public.guard_profile_privilege_columns()
RETURNS TRIGGER AS $$
DECLARE
  guarded_cols text[] := ARRAY[
    'role', 'roles', 'status',
    'deactivated', 'deactivated_at', 'deactivated_by',
    'company_id', 'customer_netsuite_id', 'is_field_installer'
  ];
  -- The staff allowlist from migration 224:42-51, plus executive: the roles
  -- that grant access beyond an installer/customer login.
  privileged_roles text[] := ARRAY[
    'admin', 'super_admin', 'sales', 'graphics_production', 'production',
    'shop_tech', 'field_tech', 'finance', 'executive'
  ];
  col text;
  old_row jsonb;
  new_row jsonb := to_jsonb(NEW);
BEGIN
  -- Service role / SECURITY DEFINER contexts carry no end-user identity.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Admins and owners manage other people's access for a living.
  IF public.get_my_roles() && ARRAY['admin', 'super_admin'] THEN
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

DROP TRIGGER IF EXISTS trg_guard_profile_privilege_columns ON public.profiles;
CREATE TRIGGER trg_guard_profile_privilege_columns
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_privilege_columns();

-- Close the companion INSERT hole: WITH CHECK (true) let any signed-in account
-- insert a row for any uuid. Service-role routes bypass RLS entirely and are
-- unaffected.
DROP POLICY IF EXISTS "profiles_insert" ON public.profiles;
CREATE POLICY "profiles_insert" ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid() OR public.is_admin());

COMMENT ON FUNCTION public.guard_profile_privilege_columns() IS
  'Migration 233: blocks self-service privilege escalation. A signed-in non-admin cannot change role, roles, status, deactivated*, company_id, customer_netsuite_id or is_field_installer on their own profile row. Service-role callers (auth.uid() IS NULL) and admin/super_admin callers are exempt.';
