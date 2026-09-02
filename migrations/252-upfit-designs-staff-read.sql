-- 252: upfit_designs reads are internal-staff-only (audit Stage 10 close).
--
-- Migration 215 created the designs table with a SELECT policy of
-- USING (true) TO authenticated — the exact shape Stage 10's CRITICAL
-- flagged on the upfit_projects tables (fixed by 224), recreated on a
-- table that postdates that fix. A customer or external-installer login
-- could read every saved 3D layout, its parts and its pricing from the
-- browser. Both reader surfaces (the designer, the project board's new
-- design panel) are staff pages; server routes use the service role.
--
-- Drift-safe: drop the permissive SELECT policy by name AND any other
-- SELECT policy that isn't the staff FOR ALL one, then make sure 215's
-- staff policy exists (FOR ALL already grants staff SELECT).

DO $$
DECLARE
  pol RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'upfit_designs'
  ) THEN
    RAISE NOTICE 'upfit_designs does not exist; skipping';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.upfit_designs ENABLE ROW LEVEL SECURITY';

  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'upfit_designs' AND cmd = 'SELECT'
  LOOP
    RAISE NOTICE 'upfit_designs: dropping SELECT policy %', pol.policyname;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.upfit_designs', pol.policyname);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'upfit_designs'
      AND policyname = 'Internal staff can manage upfit designs'
  ) THEN
    EXECUTE 'CREATE POLICY "Internal staff can manage upfit designs" ON public.upfit_designs FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())';
  END IF;
END $$;
