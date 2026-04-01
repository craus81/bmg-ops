-- Migration 044: Re-enable RLS on all tables created after migration 027
-- Fixes Supabase security advisory: "Table publicly accessible" (rls_disabled_in_public)
--
-- Tables created in migrations 028-043 may not have RLS enabled or may be
-- missing policies. This migration:
--   1. Enables RLS on ALL public tables (catches anything missed)
--   2. Adds internal-staff policies to tables from migrations 028-043
--   3. Re-runs the catch-all for any table still without policies

-- ============================================================
-- 0. Helper functions (create if they don't exist from migration 027)
-- ============================================================

-- Get current user's roles array (or fallback to legacy role)
CREATE OR REPLACE FUNCTION public.get_my_roles()
RETURNS TEXT[] AS $$
  SELECT COALESCE(
    NULLIF(roles, '{}'),
    ARRAY[role]
  )
  FROM public.profiles
  WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if current user is an admin
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT 'admin' = ANY(public.get_my_roles())
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Check if current user is internal staff (not a customer)
CREATE OR REPLACE FUNCTION public.is_internal_staff()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT role != 'customer' FROM public.profiles WHERE id = auth.uid()),
    false
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- ============================================================
-- 1. Enable RLS on ALL public tables
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE 'pg_%'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
  END LOOP;
END $$;

-- ============================================================
-- 2. CNI tables (migrations 032-039) — internal staff full access
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'cni_profiles',
      'cni_jobs',
      'cni_job_vins',
      'cni_job_status_history',
      'cni_job_invites',
      'cni_job_bids',
      'cni_job_photos',
      'cni_internal_notes',
      'cni_job_messages',
      'dashboard_layouts',
      'vehicle_notes'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_delete', tbl);
      -- Also drop catch-all policies from 027 if they exist
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_catch_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_catch_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_catch_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_catch_delete', tbl);

      EXECUTE format(
        'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_internal_staff())',
        tbl || '_select', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff())',
        tbl || '_insert', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())',
        tbl || '_update', tbl
      );
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (public.is_internal_staff())',
        tbl || '_delete', tbl
      );
    END IF;
  END LOOP;
END $$;

-- ============================================================
-- 3. app_settings (migration 043) — service role only (already has policy,
--    but ensure it's present)
-- ============================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_settings') THEN
    EXECUTE 'DROP POLICY IF EXISTS "Service role only" ON app_settings';
    EXECUTE 'DROP POLICY IF EXISTS "app_settings_catch_select" ON app_settings';
    EXECUTE 'DROP POLICY IF EXISTS "app_settings_catch_insert" ON app_settings';
    EXECUTE 'DROP POLICY IF EXISTS "app_settings_catch_update" ON app_settings';
    EXECUTE 'DROP POLICY IF EXISTS "app_settings_catch_delete" ON app_settings';
    -- Block all non-service-role access (service_role bypasses RLS)
    EXECUTE 'CREATE POLICY "app_settings_deny_all" ON app_settings FOR ALL TO authenticated USING (false) WITH CHECK (false)';
  END IF;
END $$;

-- ============================================================
-- 4. CATCH-ALL: Any remaining tables without policies get
--    internal-staff-only access
-- ============================================================
DO $$
DECLARE
  tbl RECORD;
BEGIN
  FOR tbl IN
    SELECT t.table_name
    FROM information_schema.tables t
    WHERE t.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND p.tablename = t.table_name
      )
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_internal_staff())',
      tbl.table_name || '_catch_select', tbl.table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff())',
      tbl.table_name || '_catch_insert', tbl.table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff())',
      tbl.table_name || '_catch_update', tbl.table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO authenticated USING (public.is_internal_staff())',
      tbl.table_name || '_catch_delete', tbl.table_name
    );
  END LOOP;
END $$;
