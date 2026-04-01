-- Migration 045: Security hardening
-- Fixes Supabase linter warnings:
--   1. function_search_path_mutable — all functions need SET search_path = ''
--   2. rls_policy_always_true — old permissive USING(true) policies override is_internal_staff()
--
-- NOTE: Also enable "Leaked Password Protection" in Supabase Dashboard:
--   Authentication > Settings > Password Security > Enable leaked password protection

-- ============================================================
-- 1. Fix function search paths (SET search_path = '')
-- ============================================================

-- Helper functions used by RLS policies
CREATE OR REPLACE FUNCTION public.get_my_roles()
RETURNS TEXT[] AS $$
  SELECT COALESCE(
    NULLIF(roles, '{}'),
    ARRAY[role]
  )
  FROM public.profiles
  WHERE id = auth.uid()
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN AS $$
  SELECT 'admin' = ANY(public.get_my_roles())
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

CREATE OR REPLACE FUNCTION public.is_internal_staff()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    (SELECT role != 'customer' FROM public.profiles WHERE id = auth.uid()),
    false
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = '';

-- PO installed counter
CREATE OR REPLACE FUNCTION public.increment_po_installed(p_line_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.po_line_items SET installed = installed + 1 WHERE id = p_line_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

CREATE OR REPLACE FUNCTION public.decrement_po_installed(p_line_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.po_line_items SET installed = installed - 1 WHERE id = p_line_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

-- New user handler
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, role)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    COALESCE(NEW.raw_user_meta_data->>'role', 'installer')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

-- Portal token generator (drop dependent trigger first, then recreate function)
DROP TRIGGER IF EXISTS fleet_checkins_portal_token ON fleet_checkins;
DROP FUNCTION IF EXISTS public.generate_portal_token();

CREATE OR REPLACE FUNCTION public.generate_portal_token()
RETURNS TEXT AS $$
DECLARE
  token TEXT;
BEGIN
  token := encode(gen_random_bytes(32), 'hex');
  RETURN token;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- Fleet checkins updated_at trigger (drop trigger, drop function, recreate both)
DROP TRIGGER IF EXISTS fleet_checkins_updated_at ON fleet_checkins;
DROP TRIGGER IF EXISTS update_fleet_checkins_updated_at ON fleet_checkins;
DROP FUNCTION IF EXISTS public.update_fleet_checkins_updated_at();

CREATE OR REPLACE FUNCTION public.update_fleet_checkins_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

CREATE TRIGGER update_fleet_checkins_updated_at
  BEFORE UPDATE ON fleet_checkins
  FOR EACH ROW
  EXECUTE FUNCTION public.update_fleet_checkins_updated_at();

-- Generic updated_at trigger (drop all dependent triggers first)
-- Find and drop any triggers using this function
DO $$
DECLARE
  trg RECORD;
BEGIN
  FOR trg IN
    SELECT trigger_name, event_object_table
    FROM information_schema.triggers
    WHERE action_statement LIKE '%update_updated_at%'
      AND trigger_schema = 'public'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', trg.trigger_name, trg.event_object_table);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS public.update_updated_at();

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- Recreate updated_at triggers on tables that need them
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'cni_jobs', 'cni_profiles', 'graphics_jobs', 'job_tasks',
      'knowledge_docs', 'estimates', 'estimate_line_items'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format(
        'CREATE TRIGGER update_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at()',
        tbl, tbl
      );
    END IF;
  END LOOP;
END $$;

-- CNI job number generator (drop default, trigger, then function)
ALTER TABLE cni_jobs ALTER COLUMN job_number DROP DEFAULT;
DROP TRIGGER IF EXISTS set_cni_job_number ON cni_jobs;
DROP FUNCTION IF EXISTS public.generate_cni_job_number();

CREATE OR REPLACE FUNCTION public.generate_cni_job_number()
RETURNS TRIGGER AS $$
DECLARE
  next_num INT;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(job_number FROM 5) AS INT)), 0) + 1
  INTO next_num
  FROM public.cni_jobs
  WHERE job_number LIKE 'CNI-%';
  NEW.job_number := 'CNI-' || LPAD(next_num::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

CREATE TRIGGER set_cni_job_number
  BEFORE INSERT ON cni_jobs
  FOR EACH ROW
  WHEN (NEW.job_number IS NULL)
  EXECUTE FUNCTION public.generate_cni_job_number();

-- CNI job status change logger (drop trigger first)
DROP TRIGGER IF EXISTS trg_cni_job_status_change ON cni_jobs;
DROP TRIGGER IF EXISTS log_cni_status_change ON cni_jobs;
DROP FUNCTION IF EXISTS public.log_cni_job_status_change();

CREATE OR REPLACE FUNCTION public.log_cni_job_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.cni_job_status_history (job_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.updated_by);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

CREATE TRIGGER trg_cni_job_status_change
  AFTER UPDATE ON cni_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.log_cni_job_status_change();

-- Readonly SQL executor (used by admin dashboard)
CREATE OR REPLACE FUNCTION public.exec_readonly_sql(query TEXT)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  EXECUTE query INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

-- ============================================================
-- 2. Drop old permissive USING(true) policies and replace with
--    is_internal_staff() policies
-- ============================================================

-- Helper: drops old permissive policies and creates proper ones
-- for internal-only tables
DO $$
DECLARE
  tbl TEXT;
  pol RECORD;
BEGIN
  -- Tables that had old permissive USING(true) policies
  FOR tbl IN
    SELECT unnest(ARRAY[
      'catalog',
      'contacts',
      'customers',
      'fleet_checkins',
      'graphics_proofs',
      'invoice_vehicles',
      'job_tasks',
      'notifications',
      'po_line_items',
      'purchase_orders',
      'quote_elements',
      'quote_panels',
      'quotes',
      'scanned_vehicles',
      'vehicle_photos',
      'vehicle_proofs',
      'vehicle_templates'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      -- Drop ALL existing policies on this table
      FOR pol IN
        SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = tbl
      LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, tbl);
      END LOOP;

      -- Create clean internal-staff-only policies
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
-- 3. Special cases: tables with non-internal-staff policies
--    (notifications needs user_id-based access, not just internal)
-- ============================================================

-- notifications: users see their own, internal staff can insert for anyone
DROP POLICY IF EXISTS "notifications_select" ON notifications;
DROP POLICY IF EXISTS "notifications_insert" ON notifications;
DROP POLICY IF EXISTS "notifications_update" ON notifications;
DROP POLICY IF EXISTS "notifications_delete" ON notifications;

CREATE POLICY "notifications_select" ON notifications
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "notifications_insert" ON notifications
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "notifications_update" ON notifications
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "notifications_delete" ON notifications
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- scanned_vehicles: internal staff full access, customers see assigned only
DROP POLICY IF EXISTS "scanned_vehicles_select" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_insert" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_update" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_delete" ON scanned_vehicles;

CREATE POLICY "scanned_vehicles_select" ON scanned_vehicles
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM public.customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'scanned_vehicle'
        AND cja.job_id::text = id::text
    )
  );

CREATE POLICY "scanned_vehicles_insert" ON scanned_vehicles
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "scanned_vehicles_update" ON scanned_vehicles
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "scanned_vehicles_delete" ON scanned_vehicles
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- graphics_proofs: internal staff only (no FK to graphics_jobs on this table)
-- Already handled by the bulk drop/recreate loop above, no special case needed

-- vehicle_photos: internal staff full access, customers see assigned vehicles
DROP POLICY IF EXISTS "vehicle_photos_select" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_insert" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_update" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_delete" ON vehicle_photos;

CREATE POLICY "vehicle_photos_select" ON vehicle_photos
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM public.customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'scanned_vehicle'
        AND cja.job_id::text = vehicle_id::text
    )
  );

CREATE POLICY "vehicle_photos_insert" ON vehicle_photos
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "vehicle_photos_update" ON vehicle_photos
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "vehicle_photos_delete" ON vehicle_photos
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- ============================================================
-- DONE. Remaining manual step:
--   Enable "Leaked Password Protection" in Supabase Dashboard:
--   Authentication > Settings > Password Security
-- ============================================================
