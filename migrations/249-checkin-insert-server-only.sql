-- 249: fleet_checkins INSERTs go through the server (audit Stage 7 close).
--
-- The ≥1-photo / damage-note custody gate (#713, audit item 12) lived only
-- in the browser: the check-in wizard inserted fleet_checkins directly under
-- migration 224's staff INSERT policy, so any staff console could still
-- create a photo-less check-in row (Round 3 caveat 12 — "no check-in API
-- route and no DB constraint"). POST /api/checkins is now the one writer —
-- it verifies the uploaded photo objects exist in storage BEFORE the row is
-- created — so the table's INSERT path for authenticated clients closes.
-- Service-role writers (the API route) bypass RLS and are unaffected;
-- SELECT / UPDATE / DELETE policies stay exactly as migration 224 built them
-- (the wizard still reads, and the tracking surfaces still update, from the
-- browser).
--
-- Drift-safe like the 230/247 sweeps: production was baselined from a
-- hand-migrated state, so drop EVERY policy that can grant INSERT — by any
-- name — not just 224's. A FOR ALL policy also grants INSERT, so it is
-- dropped too, and the block then guarantees SELECT/UPDATE/DELETE staff
-- policies exist (224's shape) so reads and updates survive the
-- conversion. All inside one transaction — no window without policies.

DO $$
DECLARE
  pol RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'fleet_checkins'
  ) THEN
    RAISE NOTICE 'fleet_checkins does not exist; skipping';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.fleet_checkins ENABLE ROW LEVEL SECURITY';

  -- FOR ALL policies (drift only — migration 224 created none): preserve
  -- their non-INSERT grants as the standard staff policies, then drop.
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkins' AND cmd = 'ALL'
  LOOP
    RAISE NOTICE 'fleet_checkins: converting FOR ALL policy % (drift)', pol.policyname;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.fleet_checkins', pol.policyname);
  END LOOP;

  -- Any INSERT policy, whatever its name, goes.
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkins' AND cmd = 'INSERT'
  LOOP
    RAISE NOTICE 'fleet_checkins: dropping INSERT policy %', pol.policyname;
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.fleet_checkins', pol.policyname);
  END LOOP;

  -- Make sure the three non-INSERT staff policies exist (224's shape) so a
  -- converted FOR ALL drift case doesn't lose reads/updates, and a re-run
  -- is a no-op.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkins' AND cmd = 'SELECT'
  ) THEN
    EXECUTE 'CREATE POLICY fleet_checkins_select ON public.fleet_checkins FOR SELECT TO authenticated USING (public.is_internal_staff())';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkins' AND cmd = 'UPDATE'
  ) THEN
    EXECUTE 'CREATE POLICY fleet_checkins_update ON public.fleet_checkins FOR UPDATE TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'fleet_checkins' AND cmd = 'DELETE'
  ) THEN
    EXECUTE 'CREATE POLICY fleet_checkins_delete ON public.fleet_checkins FOR DELETE TO authenticated USING (public.is_internal_staff())';
  END IF;
END $$;
