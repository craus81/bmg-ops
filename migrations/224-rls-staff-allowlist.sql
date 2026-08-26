-- Migration 224: Tighten RLS — a real internal-staff test + close USING(true) holes
--
-- From the Aug-2026 workflow audit. Three fixes; each runs inside the migration
-- runner's per-file transaction, so a failure rolls back cleanly.
--
--   1. is_internal_staff() was `role != 'customer'` and looked only at the
--      scalar `role` column. That let external CNI *installer* accounts pass as
--      internal staff on every is_internal_staff()-gated table (fleet_checkins,
--      the prospects CRM, estimates, purchase_orders, graphics_proofs, ...),
--      and ignored the roles[] array the rest of the app treats as
--      authoritative. Redefine it as a real staff allowlist evaluated over
--      get_my_roles() (roles[] with a scalar fallback).
--
--   2. vehicle_status_history still carried migration 001's permissive
--      "Users can view all status history" / "Users can create status history"
--      USING(true) policies — migration 045 rebuilt fleet_checkins but never
--      touched this table, so any authenticated account could read/insert it.
--      Rebuild both tables to internal-staff-only (dropping whatever policies
--      exist, so the fix is independent of exact legacy policy names).
--
--   3. upfit_projects / _notes / _tasks / _files shipped their policies as
--      FOR ALL / USING(true) with no `TO authenticated` clause, so even the
--      anonymous key could read, write, or delete every project. Rebuild them
--      to internal-staff-only.
--
-- NOT fixed here (deliberately): cni_jobs still lets a company member UPDATE
-- any column of their own jobs (pay_per_vehicle, invoice_status,
-- netsuite_bill_id, status) — migration 110's "Company members can update
-- company cni_jobs" grants row-level UPDATE with no column restriction, and RLS
-- cannot scope columns. The correct fix is to move those writes behind API
-- routes and reduce the policy to SELECT-only (or add a BEFORE UPDATE trigger
-- whitelisting the few installer-writable columns). That needs the installer
-- job page's direct writes rerouted first, so it is tracked as a follow-up
-- rather than guessed at here.

-- ============================================================
-- 1. Real internal-staff test (roles[]-aware; installer/customer/executive out)
-- ============================================================
-- get_my_roles() = COALESCE(NULLIF(roles,'{}'), ARRAY[role]) for the caller, or
-- NULL when no profile row exists; `&&` is array-overlap. COALESCE(...,false)
-- makes a missing profile fail closed.
CREATE OR REPLACE FUNCTION public.is_internal_staff()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    public.get_my_roles() && ARRAY[
      'admin', 'super_admin', 'sales', 'graphics_production', 'production',
      'shop_tech', 'field_tech', 'finance'
    ],
    false
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

-- ============================================================
-- 2 & 3. Rebuild internal-staff-only tables.
--   fleet_checkins / vehicle_status_history: the customer portal reads these
--   through a service-role API, never the browser client, so is_internal_staff()
--   is the whole gate — no customer branch needed.
--   upfit_projects and children: staff-only surfaces.
-- Dropping every existing policy first makes this independent of legacy names
-- and idempotent on re-run.
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
  pol RECORD;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'fleet_checkins',
      'vehicle_status_history',
      'upfit_projects',
      'upfit_project_notes',
      'upfit_project_tasks',
      'upfit_project_files'
    ])
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = tbl
    ) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

      FOR pol IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, tbl);
      END LOOP;

      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_internal_staff())',
        tbl || '_select', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff())',
        tbl || '_insert', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())',
        tbl || '_update', tbl);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (public.is_internal_staff())',
        tbl || '_delete', tbl);
    END IF;
  END LOOP;
END $$;
