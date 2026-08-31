-- Migration 247: graphics_jobs UPDATE is a graphics-side write (Stage 5).
--
-- Migration 234 fixed DELETE (admin/super_admin) but deliberately restated
-- UPDATE at its live definition: is_internal_staff() — every staff role.
-- The job page's transition rules (src/lib/graphics-status.ts: backward
-- moves need a reason, printing without an approved proof needs an admin)
-- are client-side, so any staff account could bypass them from the console
-- and, per the original Stage 5 finding, "a sales rep opening a
-- notification link can flip a job from Designing straight to Shipped."
--
-- Client-side writers are the graphics board and job pages, used by
-- graphics_production and admins; every other surface that touches
-- graphics_jobs writes through service-role API routes (RLS-exempt) or
-- only SELECTs/INSERTs (the schedule page creates jobs; that policy is
-- untouched). Sales keeps read access from migration 011.
--
-- Same drift-safe shape as 234: enumerate every UPDATE-capable policy via
-- pg_policies (this database predates the runner and has carried policies
-- no migration file describes), drop them with a NOTICE each, then restate
-- the full set so a dropped FOR ALL policy cannot strip reads or writes.

DO $sweep$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'graphics_jobs'
      AND cmd IN ('UPDATE', 'ALL')
  LOOP
    RAISE NOTICE 'migration 247: dropping % policy "%" on graphics_jobs', pol.cmd, pol.policyname;
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
  USING (public.get_my_roles() && ARRAY['admin', 'super_admin', 'graphics_production'])
  WITH CHECK (public.get_my_roles() && ARRAY['admin', 'super_admin', 'graphics_production']);

DROP POLICY IF EXISTS "graphics_jobs_delete" ON graphics_jobs;
CREATE POLICY "graphics_jobs_delete" ON graphics_jobs
  FOR DELETE TO authenticated
  USING (public.get_my_roles() && ARRAY['admin', 'super_admin']);
