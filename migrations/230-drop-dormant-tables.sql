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
-- The DROP TABLE below is deliberately NOT CASCADE: if any other dependent
-- object exists that this migration missed, the transaction fails loudly
-- instead of silently dropping policies elsewhere.

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

DROP TABLE IF EXISTS customer_job_assignments;
DROP TABLE IF EXISTS dashboard_layouts;
