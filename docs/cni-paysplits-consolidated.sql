-- ============================================================================
-- CNI + Pay-Splits — consolidated, idempotent database setup
-- ============================================================================
-- Brings a hand-applied database up to the schema the current application code
-- expects, regardless of which pieces were already pasted in. Safe to run
-- start-to-finish, and safe to re-run. Runs in one transaction, so a failure
-- rolls everything back (you stay in a consistent state).
--
-- Assumes the base CNI tables (migrations 032-039) and the core `companies`,
-- `profiles`, and `scan_logs` tables already exist. Covers migrations
-- 107, 108, 110, 111, 112, 113, 114 plus the companies-table reconciliation.
--
-- Paste the whole thing into the Supabase SQL editor and run once.
-- ============================================================================

BEGIN;

-- ── 1. Columns the code expects ─────────────────────────────────────────────

-- 107: parts + Verizon device capture
ALTER TABLE cni_jobs     ADD COLUMN IF NOT EXISTS part_number TEXT;
ALTER TABLE cni_jobs     ADD COLUMN IF NOT EXISTS part_description TEXT;
ALTER TABLE cni_jobs     ADD COLUMN IF NOT EXISTS billable_customer TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS imei TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS iccid TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS scan_log_id UUID REFERENCES scan_logs(id) ON DELETE SET NULL;

-- 108: company stamp on scans
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS scanned_by_company TEXT;

-- 110: CNI fields on the shared companies table + assignment/pay fields
ALTER TABLE companies ADD COLUMN IF NOT EXISTS primary_contact_profile_id UUID REFERENCES profiles(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address JSONB DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS netsuite_vendor_id TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS w9_file_path TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS insurance_cert_path TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS insurance_expiry DATE;
ALTER TABLE cni_profiles ADD COLUMN IF NOT EXISTS netsuite_vendor_id TEXT;
ALTER TABLE profiles     ADD COLUMN IF NOT EXISTS is_field_installer BOOLEAN DEFAULT FALSE;
ALTER TABLE cni_jobs     ADD COLUMN IF NOT EXISTS assigned_company_id UUID;   -- FK added in step 4
ALTER TABLE cni_jobs     ADD COLUMN IF NOT EXISTS pay_per_vehicle NUMERIC(10,2);
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES profiles(id);

-- 111: company-level bidding
ALTER TABLE cni_job_invites ADD COLUMN IF NOT EXISTS company_id UUID;          -- FK added in step 4
ALTER TABLE cni_job_invites ALTER COLUMN installer_id DROP NOT NULL;
ALTER TABLE cni_job_bids    ADD COLUMN IF NOT EXISTS company_id UUID;          -- FK added in step 4

-- 112: payout mode
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS payout_mode TEXT NOT NULL DEFAULT 'company'
  CHECK (payout_mode IN ('company', 'individual'));

-- 113: admin-driven scheduling (carries a time, not just a date)
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS schedule_decline_note TEXT;

-- 114: job attachments (proofs / photos / docs)
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]'::jsonb;

-- 115: column the migration-045 status-change trigger expects (without it,
-- every status-changing UPDATE on cni_jobs errors "no field updated_by").
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);

-- 116: per-job device capture (serial / IMEI / ICCID), independent of part
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS device_capture BOOLEAN DEFAULT FALSE;

-- ── 2. Pay-splits tables ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context TEXT NOT NULL CHECK (context IN ('cni', 'field')),
  cni_job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE,
  part_number TEXT,
  location_id UUID,
  location_name TEXT,
  started_by UUID REFERENCES profiles(id) NOT NULL,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CHECK (context <> 'cni' OR cni_job_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS work_shift_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID REFERENCES work_shifts(id) ON DELETE CASCADE NOT NULL,
  profile_id UUID REFERENCES profiles(id) NOT NULL,
  share_weight NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (share_weight > 0),
  added_by UUID REFERENCES profiles(id),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);

ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES work_shifts(id);

CREATE TABLE IF NOT EXISTS install_pay_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number TEXT UNIQUE NOT NULL,
  rate_per_vehicle NUMERIC(10,2) NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES profiles(id) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cni_job', 'payroll_period')),
  cni_job_id UUID REFERENCES cni_jobs(id),
  period_start DATE,
  period_end DATE,
  total_amount NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'billed', 'paid')),
  netsuite_bill_id TEXT,
  approved_by UUID REFERENCES profiles(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS install_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID REFERENCES work_shifts(id) NOT NULL,
  profile_id UUID REFERENCES profiles(id) NOT NULL,
  scan_log_id UUID REFERENCES scan_logs(id),
  cni_job_vin_id UUID REFERENCES cni_job_vins(id),
  vin TEXT,
  part_number TEXT,
  source TEXT NOT NULL CHECK (source IN ('cni', 'field')),
  rate_per_vehicle NUMERIC(10,2),
  share_weight NUMERIC(6,2) NOT NULL DEFAULT 1,
  crew_size INT NOT NULL DEFAULT 1,
  total_weight NUMERIC(8,2) NOT NULL DEFAULT 1,
  amount NUMERIC(10,2),
  payout_id UUID REFERENCES payouts(id),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by UUID REFERENCES profiles(id),
  edited_at TIMESTAMPTZ,
  CHECK (scan_log_id IS NOT NULL OR cni_job_vin_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_shifts_cni_job ON work_shifts(cni_job_id) WHERE cni_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_shifts_open ON work_shifts(context) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_shift_members_shift ON work_shift_members(shift_id);
CREATE INDEX IF NOT EXISTS idx_work_shift_members_profile ON work_shift_members(profile_id);
CREATE INDEX IF NOT EXISTS idx_install_credits_profile ON install_credits(profile_id);
CREATE INDEX IF NOT EXISTS idx_install_credits_shift ON install_credits(shift_id);
CREATE INDEX IF NOT EXISTS idx_install_credits_scan ON install_credits(scan_log_id) WHERE scan_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_vin ON install_credits(cni_job_vin_id) WHERE cni_job_vin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_unpriced ON install_credits(part_number) WHERE amount IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_payout ON install_credits(payout_id) WHERE payout_id IS NOT NULL;

-- ── 3. Drop any old policy that pointed at the separate cni_companies model ──
DROP POLICY IF EXISTS "Members can view company cni_profiles" ON cni_profiles;

-- ── 4. Point company FKs at the shared companies table ──────────────────────
-- Clear any stale ids that referenced the old cni_companies table, so the new
-- foreign keys validate.
UPDATE cni_jobs        SET assigned_company_id = NULL WHERE assigned_company_id IS NOT NULL AND assigned_company_id NOT IN (SELECT id FROM companies);
UPDATE cni_job_invites SET company_id = NULL          WHERE company_id IS NOT NULL AND company_id NOT IN (SELECT id FROM companies);
UPDATE cni_job_bids    SET company_id = NULL          WHERE company_id IS NOT NULL AND company_id NOT IN (SELECT id FROM companies);

ALTER TABLE cni_jobs        DROP CONSTRAINT IF EXISTS cni_jobs_assigned_company_id_fkey;
ALTER TABLE cni_jobs        ADD  CONSTRAINT cni_jobs_assigned_company_id_fkey FOREIGN KEY (assigned_company_id) REFERENCES companies(id);
ALTER TABLE cni_job_invites DROP CONSTRAINT IF EXISTS cni_job_invites_company_id_fkey;
ALTER TABLE cni_job_invites ADD  CONSTRAINT cni_job_invites_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);
ALTER TABLE cni_job_bids    DROP CONSTRAINT IF EXISTS cni_job_bids_company_id_fkey;
ALTER TABLE cni_job_bids    ADD  CONSTRAINT cni_job_bids_company_id_fkey FOREIGN KEY (company_id) REFERENCES companies(id);

-- ── 5. Company helper (search-path-safe; reads profiles.company_id) ─────────
CREATE OR REPLACE FUNCTION cni_user_company_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM public.profiles WHERE id = auth.uid()
$$;

-- ── 6. RLS (idempotent: drop-then-create each policy) ───────────────────────
ALTER TABLE work_shifts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_shift_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pay_rates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts            ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_credits    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin full access to work_shifts" ON work_shifts;
CREATE POLICY "Admin full access to work_shifts" ON work_shifts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
DROP POLICY IF EXISTS "Admin full access to work_shift_members" ON work_shift_members;
CREATE POLICY "Admin full access to work_shift_members" ON work_shift_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
DROP POLICY IF EXISTS "Admin full access to install_pay_rates" ON install_pay_rates;
CREATE POLICY "Admin full access to install_pay_rates" ON install_pay_rates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
DROP POLICY IF EXISTS "Admin full access to payouts" ON payouts;
CREATE POLICY "Admin full access to payouts" ON payouts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
DROP POLICY IF EXISTS "Admin full access to install_credits" ON install_credits;
CREATE POLICY "Admin full access to install_credits" ON install_credits FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));

DROP POLICY IF EXISTS "Users can view own install_credits" ON install_credits;
CREATE POLICY "Users can view own install_credits" ON install_credits FOR SELECT TO authenticated
  USING (profile_id = auth.uid());
DROP POLICY IF EXISTS "Users can view own payouts" ON payouts;
CREATE POLICY "Users can view own payouts" ON payouts FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "Company members can view company cni_jobs" ON cni_jobs;
CREATE POLICY "Company members can view company cni_jobs" ON cni_jobs FOR SELECT TO authenticated
  USING (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id());
DROP POLICY IF EXISTS "Company members can update company cni_jobs" ON cni_jobs;
CREATE POLICY "Company members can update company cni_jobs" ON cni_jobs FOR UPDATE TO authenticated
  USING (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id())
  WITH CHECK (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id());

DROP POLICY IF EXISTS "Company members can view cni_job_vins" ON cni_job_vins;
CREATE POLICY "Company members can view cni_job_vins" ON cni_job_vins FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));
DROP POLICY IF EXISTS "Company members can update cni_job_vins" ON cni_job_vins;
CREATE POLICY "Company members can update cni_job_vins" ON cni_job_vins FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

DROP POLICY IF EXISTS "Company members can upload cni_job_photos" ON cni_job_photos;
CREATE POLICY "Company members can upload cni_job_photos" ON cni_job_photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id())
  );
DROP POLICY IF EXISTS "Company members can read cni_job_photos" ON cni_job_photos;
CREATE POLICY "Company members can read cni_job_photos" ON cni_job_photos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

DROP POLICY IF EXISTS "Company members can rw cni_job_messages" ON cni_job_messages;
CREATE POLICY "Company members can rw cni_job_messages" ON cni_job_messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

DROP POLICY IF EXISTS "Company members can view cni_job_status_history" ON cni_job_status_history;
CREATE POLICY "Company members can view cni_job_status_history" ON cni_job_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

DROP POLICY IF EXISTS "Members can view company profiles" ON profiles;
CREATE POLICY "Members can view company profiles" ON profiles FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());

DROP POLICY IF EXISTS "Company members can view company invites" ON cni_job_invites;
CREATE POLICY "Company members can view company invites" ON cni_job_invites FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());
DROP POLICY IF EXISTS "Company members can view company bids" ON cni_job_bids;
CREATE POLICY "Company members can view company bids" ON cni_job_bids FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());
DROP POLICY IF EXISTS "installer_create_own_bids" ON cni_job_bids;
CREATE POLICY "installer_create_own_bids" ON cni_job_bids FOR INSERT TO authenticated
  WITH CHECK (installer_id = auth.uid() AND (company_id IS NULL OR company_id = cni_user_company_id()));

-- ── 7. Backfills (idempotent) ───────────────────────────────────────────────
UPDATE cni_jobs j SET assigned_company_id = p.company_id
FROM profiles p
WHERE j.assigned_company_id IS NULL AND j.assigned_installer_id IS NOT NULL
  AND j.status <> 'approved_closed' AND p.id = j.assigned_installer_id AND p.company_id IS NOT NULL;

UPDATE cni_job_invites i SET company_id = p.company_id
FROM profiles p WHERE i.company_id IS NULL AND i.installer_id IS NOT NULL AND p.id = i.installer_id;

UPDATE cni_job_bids b SET company_id = p.company_id
FROM profiles p WHERE b.company_id IS NULL AND p.id = b.installer_id;

-- Remove invites that would collide on (job_id, company_id) after backfill
-- (the old model had one invite per installer; companies may share installers).
DELETE FROM cni_job_invites a USING cni_job_invites b
WHERE a.ctid < b.ctid AND a.job_id = b.job_id AND a.company_id = b.company_id AND a.company_id IS NOT NULL;

-- ── 8. Indexes that depend on the backfilled company columns ────────────────
CREATE INDEX IF NOT EXISTS idx_cni_jobs_assigned_company ON cni_jobs(assigned_company_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cni_job_invites_job_company ON cni_job_invites(job_id, company_id) WHERE company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cni_job_bids_company ON cni_job_bids(company_id) WHERE company_id IS NOT NULL;

COMMIT;
