-- Migration 328: the last policies still built on the pre-graphics_production
-- role list, found on 2026-09-25 with
--   select tablename, policyname, cmd from pg_policies
--   where qual/with_check mention 'production' but not 'graphics_production'
-- which returned exactly: graphics_status_history INSERT + SELECT,
-- job_assignments "Production can assign graphics jobs", knowledge_docs_select.
--
-- ── 1. graphics_status_history (the job activity / notes feed) ──────────
--
-- Migration 133 widened this table's INSERT/SELECT to admin, production,
-- graphics_production and sales, but it predates the migration runner and
-- was baselined as applied without ever running here. Production still
-- carried the migration 010/011 policies, read off pg_policies on
-- 2026-09-25:
--   INSERT: profiles.role IN ('admin', 'production')
--   SELECT: profiles.role IN ('admin', 'production', 'sales')
-- So graphics_production could neither post a note nor read the feed, and
-- sales could not post. Nobody noticed while the graphics staff still
-- carried the legacy 'production' value; moving the last of them to
-- graphics_production (so migration 247 would let her change a job's
-- status) turned every note of hers into "new row violates row-level
-- security policy", and her status-change history rows failed the same way
-- (the job page ignores that insert's error).
--
-- Both policies also tested only the single profiles.role column, while
-- every modern policy reads get_my_roles() (roles[], falling back to role),
-- so an account could pass the graphics_jobs rules and fail this one.
--
-- Owner decision 2026-09-25: every staff role can read and post job notes.
-- Restated on is_internal_staff() (migration 224: the staff allowlist, read
-- through get_my_roles(), legacy 'production' included) — the same test
-- graphics_jobs SELECT uses (247). Whoever can open a job can read its
-- activity and comment on it; notifications already deep-link shop and
-- field techs to the job page.
--
-- Same drift-safe shape as 247: drop every INSERT/SELECT/ALL policy the
-- database actually has on the table (it has carried policies no file
-- describes), then restate. UPDATE/DELETE policies are left alone.

DO $sweep$
DECLARE
  pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname, cmd
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'graphics_status_history'
      AND cmd IN ('INSERT', 'SELECT', 'ALL')
  LOOP
    RAISE NOTICE 'migration 328: dropping % policy "%" on graphics_status_history', pol.cmd, pol.policyname;
    EXECUTE format('DROP POLICY %I ON public.graphics_status_history', pol.policyname);
  END LOOP;
END
$sweep$;

ALTER TABLE graphics_status_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "graphics_history_select" ON graphics_status_history;
CREATE POLICY "graphics_history_select" ON graphics_status_history
  FOR SELECT TO authenticated
  USING (public.is_internal_staff());

DROP POLICY IF EXISTS "graphics_history_insert" ON graphics_status_history;
CREATE POLICY "graphics_history_insert" ON graphics_status_history
  FOR INSERT TO authenticated
  WITH CHECK (public.is_internal_staff());

-- ── 2. job_assignments: "Production can assign graphics jobs" ───────────
-- From migration 020: role IN ('production', 'admin') on the single role
-- column, so a graphics_production account fails it. The browser only
-- reads job_assignments today (assignments save through the service-role
-- /api/jobs/assign), so this is parity, not a live fix — restated rather
-- than dropped so the graphics staff keep exactly the right they had.
DROP POLICY IF EXISTS "Production can assign graphics jobs" ON job_assignments;
CREATE POLICY "Production can assign graphics jobs" ON job_assignments
  FOR INSERT TO authenticated
  WITH CHECK (
    job_type = 'graphics_job'
    AND public.get_my_roles() && ARRAY['admin', 'super_admin', 'graphics_production', 'production']
  );

-- ── 3. knowledge_docs_select ───────────────────────────────────────────
-- From migration 016: admin, sales and production may read the knowledge
-- base, on the single role column. Same audience, read through
-- get_my_roles() with super_admin and graphics_production added, status
-- check kept. Help articles keep their own everyone-approved policy (093).
DROP POLICY IF EXISTS knowledge_docs_select ON knowledge_docs;
CREATE POLICY knowledge_docs_select ON knowledge_docs
  FOR SELECT TO authenticated
  USING (
    public.get_my_roles() && ARRAY['admin', 'super_admin', 'sales', 'graphics_production', 'production']
    AND EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND status = 'approved')
  );
