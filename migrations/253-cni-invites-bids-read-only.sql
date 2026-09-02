-- 253: cni_job_invites / cni_job_bids browser writes close (audit CNI
-- section close — the follow-up #715 deferred).
--
-- #715 moved the invite/bid writes onto server routes (invite-company,
-- bid) so they could notify; the RLS write policies were "deliberately
-- unchanged — the migration-226 read-only treatment is the follow-up once
-- the routes soak." They soaked: the routes carried production traffic
-- (and the invite 42P10 was found and fixed through them, #724). This
-- applies the 226 treatment — reads keep their scoped policies, every
-- write goes through the service-role routes:
--   * drops the installer INSERT policy on bids (036/111) and any other
--     write-capable policy on either table, admin FOR ALL included — the
--     coordinator surfaces write through /api/cni/invite-company and
--     /api/cni/bid too;
--   * keeps the scoped SELECTs (installer-own, company-view) and adds an
--     internal-staff SELECT so coordinator pages keep reading after the
--     admin FOR ALL (which carried their reads) is gone.
-- Drift-safe like 249/250/252: policies are swept by command, not by name.

DO $$
DECLARE
  tbl TEXT;
  pol RECORD;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['cni_job_invites', 'cni_job_bids'])
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      RAISE NOTICE '%: does not exist; skipping', tbl;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);

    FOR pol IN
      SELECT policyname, cmd FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl AND cmd <> 'SELECT'
    LOOP
      RAISE NOTICE '%: dropping %-capable policy %', tbl, pol.cmd, pol.policyname;
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, tbl);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = tbl
        AND policyname = tbl || '_staff_select'
    ) THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_internal_staff())',
        tbl || '_staff_select', tbl);
    END IF;
  END LOOP;
END $$;
