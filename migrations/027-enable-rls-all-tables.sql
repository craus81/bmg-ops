-- Migration 027: Enable Row Level Security with tiered access controls
-- Fixes Supabase security advisory: "Table publicly accessible" (rls_disabled_in_public)
--
-- TIERS:
--   1. Helper functions: is_admin(), is_internal_staff()
--   2. Personal data: own-rows only (notifications, notification_preferences, google_tokens)
--   3. Conversations/messages: participant-only access
--   4. Customer isolation: customers only see their assigned jobs
--   5. Internal-only tables: full CRUD for internal staff, blocked for customers
--   6. Read-all tables: profiles, companies (everyone can read, restricted writes)
--
-- NOTE: API routes use service_role key which bypasses RLS entirely.

-- ============================================================
-- 0. Enable RLS on ALL tables first
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
-- 1. Helper functions (SECURITY DEFINER to bypass RLS on profiles)
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
-- 2. PROFILES — everyone reads, users update own, admins update all
-- ============================================================
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update_own" ON profiles;
DROP POLICY IF EXISTS "profiles_update_admin" ON profiles;
DROP POLICY IF EXISTS "profiles_delete" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;

CREATE POLICY "profiles_select" ON profiles
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "profiles_insert" ON profiles
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "profiles_update_admin" ON profiles
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

CREATE POLICY "profiles_delete" ON profiles
  FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================
-- 3. COMPANIES — everyone reads, internal staff writes
-- ============================================================
DROP POLICY IF EXISTS "companies_select" ON companies;
DROP POLICY IF EXISTS "companies_insert" ON companies;
DROP POLICY IF EXISTS "companies_update" ON companies;
DROP POLICY IF EXISTS "companies_delete" ON companies;

CREATE POLICY "companies_select" ON companies
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "companies_insert" ON companies
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "companies_update" ON companies
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "companies_delete" ON companies
  FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================
-- 4. PERSONAL DATA — own rows only
-- ============================================================

-- notifications: user sees/updates only their own
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

-- notification_preferences: own rows only
DROP POLICY IF EXISTS "notification_preferences_select" ON notification_preferences;
DROP POLICY IF EXISTS "notification_preferences_insert" ON notification_preferences;
DROP POLICY IF EXISTS "notification_preferences_update" ON notification_preferences;
DROP POLICY IF EXISTS "notification_preferences_delete" ON notification_preferences;

CREATE POLICY "notification_preferences_select" ON notification_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "notification_preferences_insert" ON notification_preferences
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "notification_preferences_update" ON notification_preferences
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

CREATE POLICY "notification_preferences_delete" ON notification_preferences
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- google_tokens: admin-only (accessed via service role from API routes)
DROP POLICY IF EXISTS "google_tokens_select" ON google_tokens;
DROP POLICY IF EXISTS "google_tokens_insert" ON google_tokens;
DROP POLICY IF EXISTS "google_tokens_update" ON google_tokens;
DROP POLICY IF EXISTS "google_tokens_delete" ON google_tokens;

CREATE POLICY "google_tokens_select" ON google_tokens
  FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY "google_tokens_insert" ON google_tokens
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());

CREATE POLICY "google_tokens_update" ON google_tokens
  FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE POLICY "google_tokens_delete" ON google_tokens
  FOR DELETE TO authenticated USING (public.is_admin());

-- time_entries: own rows + admin can see all
DROP POLICY IF EXISTS "time_entries_select" ON time_entries;
DROP POLICY IF EXISTS "time_entries_insert" ON time_entries;
DROP POLICY IF EXISTS "time_entries_update" ON time_entries;
DROP POLICY IF EXISTS "time_entries_delete" ON time_entries;

CREATE POLICY "time_entries_select" ON time_entries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "time_entries_insert" ON time_entries
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

CREATE POLICY "time_entries_update" ON time_entries
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.is_admin())
  WITH CHECK (user_id = auth.uid() OR public.is_admin());

CREATE POLICY "time_entries_delete" ON time_entries
  FOR DELETE TO authenticated USING (public.is_admin());

-- time_breaks: linked through time_entry_id — own entries + admin sees all
DROP POLICY IF EXISTS "time_breaks_select" ON time_breaks;
DROP POLICY IF EXISTS "time_breaks_insert" ON time_breaks;
DROP POLICY IF EXISTS "time_breaks_update" ON time_breaks;
DROP POLICY IF EXISTS "time_breaks_delete" ON time_breaks;

CREATE POLICY "time_breaks_select" ON time_breaks
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM time_entries te WHERE te.id = time_entry_id AND te.user_id = auth.uid())
    OR public.is_admin()
  );

CREATE POLICY "time_breaks_insert" ON time_breaks
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM time_entries te WHERE te.id = time_entry_id AND te.user_id = auth.uid())
  );

CREATE POLICY "time_breaks_update" ON time_breaks
  FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM time_entries te WHERE te.id = time_entry_id AND te.user_id = auth.uid())
    OR public.is_admin()
  )
  WITH CHECK (true);

CREATE POLICY "time_breaks_delete" ON time_breaks
  FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================
-- 5. CONVERSATIONS & MESSAGES — participants only
-- ============================================================

-- conversations: only if you are participant_1 or participant_2
DROP POLICY IF EXISTS "conversations_select" ON conversations;
DROP POLICY IF EXISTS "conversations_insert" ON conversations;
DROP POLICY IF EXISTS "conversations_update" ON conversations;
DROP POLICY IF EXISTS "conversations_delete" ON conversations;

CREATE POLICY "conversations_select" ON conversations
  FOR SELECT TO authenticated
  USING (participant_1 = auth.uid() OR participant_2 = auth.uid());

CREATE POLICY "conversations_insert" ON conversations
  FOR INSERT TO authenticated
  WITH CHECK (participant_1 = auth.uid() OR participant_2 = auth.uid());

CREATE POLICY "conversations_update" ON conversations
  FOR UPDATE TO authenticated
  USING (participant_1 = auth.uid() OR participant_2 = auth.uid())
  WITH CHECK (participant_1 = auth.uid() OR participant_2 = auth.uid());

CREATE POLICY "conversations_delete" ON conversations
  FOR DELETE TO authenticated USING (public.is_admin());

-- messages: only if you are in the conversation
DROP POLICY IF EXISTS "messages_select" ON messages;
DROP POLICY IF EXISTS "messages_insert" ON messages;
DROP POLICY IF EXISTS "messages_update" ON messages;
DROP POLICY IF EXISTS "messages_delete" ON messages;

CREATE POLICY "messages_select" ON messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
        AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );

CREATE POLICY "messages_insert" ON messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid() AND
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
        AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );

CREATE POLICY "messages_update" ON messages
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
        AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  )
  WITH CHECK (true);

CREATE POLICY "messages_delete" ON messages
  FOR DELETE TO authenticated USING (public.is_admin());

-- ============================================================
-- 6. CUSTOMER JOB ASSIGNMENTS — customers see own, internal sees all
-- ============================================================
DROP POLICY IF EXISTS "customer_job_assignments_select" ON customer_job_assignments;
DROP POLICY IF EXISTS "customer_job_assignments_insert" ON customer_job_assignments;
DROP POLICY IF EXISTS "customer_job_assignments_update" ON customer_job_assignments;
DROP POLICY IF EXISTS "customer_job_assignments_delete" ON customer_job_assignments;

CREATE POLICY "customer_job_assignments_select" ON customer_job_assignments
  FOR SELECT TO authenticated
  USING (customer_user_id = auth.uid() OR public.is_internal_staff());

CREATE POLICY "customer_job_assignments_insert" ON customer_job_assignments
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "customer_job_assignments_update" ON customer_job_assignments
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "customer_job_assignments_delete" ON customer_job_assignments
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- ============================================================
-- 7. JOB-RELATED TABLES — internal staff full access,
--    customers only see their assigned jobs
-- ============================================================

-- scanned_vehicles: internal = full, customers = only assigned
DROP POLICY IF EXISTS "scanned_vehicles_select" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_insert" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_update" ON scanned_vehicles;
DROP POLICY IF EXISTS "scanned_vehicles_delete" ON scanned_vehicles;

CREATE POLICY "scanned_vehicles_select" ON scanned_vehicles
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'scanned_vehicle'
        AND cja.job_id = id::text
    )
  );

CREATE POLICY "scanned_vehicles_insert" ON scanned_vehicles
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "scanned_vehicles_update" ON scanned_vehicles
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "scanned_vehicles_delete" ON scanned_vehicles
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- graphics_jobs: internal = full, customers = only assigned
DROP POLICY IF EXISTS "graphics_jobs_select" ON graphics_jobs;
DROP POLICY IF EXISTS "graphics_jobs_insert" ON graphics_jobs;
DROP POLICY IF EXISTS "graphics_jobs_update" ON graphics_jobs;
DROP POLICY IF EXISTS "graphics_jobs_delete" ON graphics_jobs;

CREATE POLICY "graphics_jobs_select" ON graphics_jobs
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'graphics_job'
        AND cja.job_id = id::text
    )
  );

CREATE POLICY "graphics_jobs_insert" ON graphics_jobs
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "graphics_jobs_update" ON graphics_jobs
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "graphics_jobs_delete" ON graphics_jobs
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- vehicle_photos: internal = full, customers = only their assigned vehicles
DROP POLICY IF EXISTS "vehicle_photos_select" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_insert" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_update" ON vehicle_photos;
DROP POLICY IF EXISTS "vehicle_photos_delete" ON vehicle_photos;

CREATE POLICY "vehicle_photos_select" ON vehicle_photos
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'scanned_vehicle'
        AND cja.job_id = vehicle_id::text
    )
  );

CREATE POLICY "vehicle_photos_insert" ON vehicle_photos
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "vehicle_photos_update" ON vehicle_photos
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "vehicle_photos_delete" ON vehicle_photos
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- graphics_proofs: internal = full, customers = only their assigned graphics jobs
DROP POLICY IF EXISTS "graphics_proofs_select" ON graphics_proofs;
DROP POLICY IF EXISTS "graphics_proofs_insert" ON graphics_proofs;
DROP POLICY IF EXISTS "graphics_proofs_update" ON graphics_proofs;
DROP POLICY IF EXISTS "graphics_proofs_delete" ON graphics_proofs;

CREATE POLICY "graphics_proofs_select" ON graphics_proofs
  FOR SELECT TO authenticated
  USING (
    public.is_internal_staff()
    OR EXISTS (
      SELECT 1 FROM customer_job_assignments cja
      WHERE cja.customer_user_id = auth.uid()
        AND cja.job_type = 'graphics_job'
        AND cja.job_id = graphics_job_id::text
    )
  );

CREATE POLICY "graphics_proofs_insert" ON graphics_proofs
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());

CREATE POLICY "graphics_proofs_update" ON graphics_proofs
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "graphics_proofs_delete" ON graphics_proofs
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- ============================================================
-- 8. INTERNAL-ONLY TABLES — full CRUD for internal staff, blocked for customers
--    These tables contain operational data customers should never see.
-- ============================================================

-- Macro: for each internal-only table, create 4 standard policies
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY[
      'fleet_checkins',
      'vehicle_status_history',
      'vehicle_templates',
      'vehicle_proofs',
      'graphics_status_history',
      'invoices',
      'invoice_vehicles',
      'purchase_orders',
      'po_line_items',
      'po_invoices',
      'quotes',
      'quote_elements',
      'quote_panels',
      'estimates',
      'estimate_line_items',
      'catalog',
      'catalog_proofs',
      'netsuite_parts',
      'parts_sync_log',
      'schedule_entries',
      'schedule_assignments',
      'knowledge_docs',
      'job_assignments',
      'job_tasks',
      'photos',
      'proofs',
      'gmail_po_imports',
      'customers',
      'contacts',
      'locations'
    ])
  LOOP
    -- Only create if table exists
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_delete', tbl);

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
-- 9. HYPHENATED TABLE NAMES (if they exist)
-- ============================================================
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN
    SELECT unnest(ARRAY['quote-proofs', 'knowledge-files'])
  LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = tbl) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_select', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_insert', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_update', tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl || '_delete', tbl);

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
-- 10. CATCH-ALL: Any remaining tables we missed get basic
--     authenticated-only access (no anonymous access)
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
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl.table_name || '_catch_select', tbl.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl.table_name || '_catch_insert', tbl.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl.table_name || '_catch_update', tbl.table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', tbl.table_name || '_catch_delete', tbl.table_name);

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

-- ============================================================
-- DONE. Summary of access tiers:
--
-- ANONYMOUS users:           ❌ Blocked from ALL tables
-- CUSTOMERS (authenticated): ✅ Own profile, notifications, preferences
--                            ✅ Own assigned jobs (via customer_job_assignments)
--                            ✅ Photos/proofs for assigned jobs
--                            ✅ Conversations they participate in
--                            ❌ No access to internal ops tables
-- INTERNAL STAFF:            ✅ Full CRUD on all operational tables
--                            ✅ Own time entries (admin sees all)
--                            ✅ Own notifications/preferences
--                            ✅ Own conversations
-- ADMINS:                    ✅ Everything above
--                            ✅ Edit any user profile
--                            ✅ Delete profiles, conversations
--                            ✅ All time entries (view/edit)
-- SERVICE ROLE (API routes): ✅ Bypasses RLS entirely
-- ============================================================
