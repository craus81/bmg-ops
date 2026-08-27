-- Migration 230: drop the two dormant tables the 2026-08 audit flagged
-- (owner sign-off 2026-08-27).
--
-- customer_job_assignments (migrations/019) was the original customer-portal
-- wiring: an admin hand-assigned every vehicle/graphics job to every customer
-- login. Migration 157 replaced that with profiles.customer_netsuite_id (one
-- link per login scopes everything), and the portal reads through the
-- service-role /api/customer/portal route since. Zero code references remain.
--
-- dashboard_layouts (migrations/040) backed a per-user dashboard arrangement
-- feature that never shipped a writer. Zero code references; its policies
-- are self-contained and drop with the table.
--
-- Three live RLS policies still reference customer_job_assignments in an OR
-- arm, so a plain DROP would be blocked by their dependency. Each is
-- recreated first with only its other arm — which is the only arm any live
-- path uses (the table is dormant: nothing writes it, and its historical
-- rows point at the retired scanned_vehicles ids), so the effective access
-- surface does not change:
--   graphics_jobs_select        (from 027 — never touched since)
--   vehicle_photos_select       (from 045)
--   scanned_vehicles_select     (from 045; lives on scanned_vehicles_retired
--                                since the 193 rename)
--
-- 2026-08-27 deploy failure: production (baselined from a hand-migrated
-- database, so its policy set predates the files) held MORE policies
-- referencing customer_job_assignments than those three, and the
-- non-CASCADE drop below failed every deploy from #669 on ("cannot drop
-- table customer_job_assignments because other objects depend on it").
-- The sweep between the recreations and the drops finds every REMAINING
-- policy that depends on either dormant table via pg_depend and recreates
-- it internal-staff-only — the same conversion as the three above, for the
-- same reason: a cja/dashboard_layouts arm can never grant anything real
-- again, and the customer portal reads through the service role (157+),
-- which RLS does not constrain. Each conversion RAISEs a NOTICE so the
-- deploy log records exactly what production held.
--
-- The DROP TABLE below is deliberately NOT CASCADE: if any NON-policy
-- dependent object exists that the sweep can't handle (a view, an FK),
-- the transaction still fails loudly instead of silently dropping
-- objects elsewhere.

DROP POLICY IF EXISTS "graphics_jobs_select" ON graphics_jobs;
CREATE POLICY "graphics_jobs_select" ON graphics_jobs
  FOR SELECT TO authenticated
  USING (public.is_internal_staff());

DROP POLICY IF EXISTS "vehicle_photos_select" ON vehicle_photos;
CREATE POLICY "vehicle_photos_select" ON vehicle_photos
  FOR SELECT TO authenticated
  USING (public.is_internal_staff());

DROP POLICY IF EXISTS "scanned_vehicles_select" ON scanned_vehicles_retired;
CREATE POLICY "scanned_vehicles_select" ON scanned_vehicles_retired
  FOR SELECT TO authenticated
  USING (public.is_internal_staff());

-- Sweep: recreate internal-staff-only every remaining policy that still
-- depends on either dormant table (see header). Policies ON the dormant
-- tables themselves are skipped — they drop with their table. On a fresh
-- database replaying the whole chain this finds nothing and is a no-op.
DO $sweep$
DECLARE
  targets oid[] := ARRAY(
    SELECT t::oid FROM unnest(ARRAY[
      to_regclass('public.customer_job_assignments'),
      to_regclass('public.dashboard_layouts')
    ]) AS t WHERE t IS NOT NULL
  );
  dep RECORD;
BEGIN
  IF coalesce(array_length(targets, 1), 0) = 0 THEN
    RETURN;
  END IF;
  FOR dep IN
    SELECT DISTINCT pol.polname, pol.polcmd, pol.polpermissive,
                    n.nspname, c.relname
    FROM pg_depend d
    JOIN pg_policy pol ON pol.oid = d.objid
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE d.classid = 'pg_policy'::regclass
      AND d.refclassid = 'pg_class'::regclass
      AND d.refobjid = ANY (targets)
      AND NOT (pol.polrelid = ANY (targets))
  LOOP
    RAISE NOTICE 'migration 230: policy "%" on %.% still referenced a dormant table — recreated internal-staff-only',
      dep.polname, dep.nspname, dep.relname;
    EXECUTE format('DROP POLICY %I ON %I.%I', dep.polname, dep.nspname, dep.relname);
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I %s FOR %s TO authenticated %s',
      dep.polname, dep.nspname, dep.relname,
      CASE WHEN dep.polpermissive THEN '' ELSE 'AS RESTRICTIVE' END,
      CASE dep.polcmd
        WHEN 'r' THEN 'SELECT'
        WHEN 'a' THEN 'INSERT'
        WHEN 'w' THEN 'UPDATE'
        WHEN 'd' THEN 'DELETE'
        ELSE 'ALL'
      END,
      CASE dep.polcmd
        WHEN 'a' THEN 'WITH CHECK (public.is_internal_staff())'
        WHEN 'w' THEN 'USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())'
        WHEN '*' THEN 'USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())'
        ELSE 'USING (public.is_internal_staff())'
      END
    );
  END LOOP;
END
$sweep$;

DROP TABLE IF EXISTS customer_job_assignments;
DROP TABLE IF EXISTS dashboard_layouts;
