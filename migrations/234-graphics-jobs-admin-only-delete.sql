-- Migration 234: only admins may delete a graphics job
--
-- THE HOLE: graphics_jobs_delete has been
--   FOR DELETE TO authenticated USING (public.is_internal_staff())
-- since migrations/027-enable-rls-all-tables.sql:391-392, and no later
-- migration touches it (230 rebuilt only graphics_jobs_select). Migration 224
-- narrowed is_internal_staff() to a staff allowlist, which evicted external CNI
-- installers -- but sales, shop_tech, field_tech and graphics_production still
-- pass it. Meanwhile the Delete button is admin-gated in JSX only
-- (src/app/(main)/graphics/[id]/page.tsx:1034) and the delete is a direct
-- browser call (:623), so any staff account can delete any graphics job -- and
-- the job's whole history with it -- from the console.
--
-- DRIFT: this database was baselined from a hand-migrated state and is known to
-- carry policies that exist in no migration file (the 230 incident, #675). So
-- do NOT drop graphics_jobs_delete by name and assume that is the only
-- DELETE-capable policy: a leftover FOR ALL policy would keep the hole open
-- while this migration reports success. Enumerate pg_policies instead and drop
-- every DELETE-capable policy found, RAISE NOTICE-ing each one. The DO-block-
-- over-pg_policies shape is this repo's idiom (224:66-86), and since #675 the
-- runner surfaces notices, so the deploy log becomes the record of what
-- production actually carried.
--
-- The other three policies are then restated so that dropping a FOR ALL policy
-- cannot strip staff of their reads and writes. select is restated at its LIVE
-- definition (230:43-46, staff-only) -- NOT 027's original, whose customer
-- branch referenced customer_job_assignments and died with that table.
--
-- Delete is granted to admin OR super_admin via get_my_roles(), not is_admin():
-- is_admin() tests only for the literal 'admin' role (027:69-72), so a pure
-- super_admin would be locked out of a destructive action they own. Same
-- reasoning as migration 233.

DO $sweep$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'graphics_jobs'
      AND cmd IN ('DELETE', 'ALL')
  LOOP
    RAISE NOTICE 'migration 234: dropping % policy "%" on graphics_jobs', pol.cmd, pol.policyname;
    EXECUTE format('DROP POLICY %I ON public.graphics_jobs', pol.policyname);
  END LOOP;
END
$sweep$;

DROP POLICY IF EXISTS "graphics_jobs_select" ON graphics_jobs;
CREATE POLICY "graphics_jobs_select" ON graphics_jobs
  FOR SELECT TO authenticated
  USING (public.is_internal_staff());

DROP POLICY IF EXISTS "graphics_jobs_insert" ON graphics_jobs;
CREATE POLICY "graphics_jobs_insert" ON graphics_jobs
  FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_staff());

DROP POLICY IF EXISTS "graphics_jobs_update" ON graphics_jobs;
CREATE POLICY "graphics_jobs_update" ON graphics_jobs
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());

DROP POLICY IF EXISTS "graphics_jobs_delete" ON graphics_jobs;
CREATE POLICY "graphics_jobs_delete" ON graphics_jobs
  FOR DELETE TO authenticated
  USING (public.get_my_roles() && ARRAY['admin', 'super_admin']);
