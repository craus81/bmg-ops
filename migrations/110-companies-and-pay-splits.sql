-- Companies + per-vehicle pay splits (phase 1 of docs/pay-splits-design.md)
--
-- CNI jobs move from a single assigned installer to an assigned COMPANY: any
-- installer at the company can schedule, scan, and complete work. Crews are
-- tagged per shift, and every completed vehicle snapshots a per-member pay
-- credit (rate × weight / Σ weights). Field (/scan) installs get the same
-- shift + credit mechanics with rates from install_pay_rates.

-- ── 1. Companies ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cni_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  -- Notify-only contact; no special workflow powers (there is no "lead").
  primary_contact_profile_id UUID REFERENCES profiles(id),
  phone TEXT,
  email TEXT,
  address JSONB DEFAULT '{}'::jsonb,
  -- Company-level vendor for the lump-sum payout mode (phase 3).
  netsuite_vendor_id TEXT,
  -- Company-level compliance docs (per-person docs stay on cni_profiles).
  w9_file_path TEXT,
  insurance_cert_path TEXT,
  insurance_expiry DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE cni_profiles ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES cni_companies(id);
-- Per-person vendor for individual payouts (phase 3).
ALTER TABLE cni_profiles ADD COLUMN IF NOT EXISTS netsuite_vendor_id TEXT;

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS assigned_company_id UUID REFERENCES cni_companies(id);
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS pay_per_vehicle NUMERIC(10,2);

-- Curated field crew picker ("field installer" flag on internal profiles;
-- field_tech-role users are included by the roster query regardless).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_field_installer BOOLEAN DEFAULT FALSE;

-- Backfill: company_name values are clean (assigned from a dropdown), so one
-- company per distinct trimmed name, then link profiles.
INSERT INTO cni_companies (name)
SELECT DISTINCT TRIM(company_name)
FROM cni_profiles
WHERE company_name IS NOT NULL AND TRIM(company_name) <> ''
ON CONFLICT (name) DO NOTHING;

UPDATE cni_profiles p
SET company_id = c.id
FROM cni_companies c
WHERE p.company_id IS NULL
  AND p.company_name IS NOT NULL
  AND TRIM(p.company_name) = c.name;

-- Map open jobs to the assigned installer's company. Closed jobs are left
-- installer-only on purpose: visibility broadens for new/active work only.
UPDATE cni_jobs j
SET assigned_company_id = cp.company_id
FROM cni_profiles cp
WHERE j.assigned_company_id IS NULL
  AND j.assigned_installer_id IS NOT NULL
  AND j.status <> 'approved_closed'
  AND cp.user_id = j.assigned_installer_id;

CREATE INDEX IF NOT EXISTS idx_cni_profiles_company ON cni_profiles(company_id);
CREATE INDEX IF NOT EXISTS idx_cni_jobs_assigned_company ON cni_jobs(assigned_company_id);

-- ── 2. Shifts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS work_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context TEXT NOT NULL CHECK (context IN ('cni', 'field')),
  cni_job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE,  -- cni shifts
  part_number TEXT,                                           -- field shifts (incl. custom job names)
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
  -- Uneven splits: per-vehicle amount = rate × weight / Σ active weights.
  share_weight NUMERIC(6,2) NOT NULL DEFAULT 1 CHECK (share_weight > 0),
  added_by UUID REFERENCES profiles(id),
  added_at TIMESTAMPTZ DEFAULT NOW(),
  -- Untagging sets removed_at instead of deleting, so credits already
  -- snapshotted (and the audit trail) keep their reference.
  removed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_work_shifts_cni_job ON work_shifts(cni_job_id) WHERE cni_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_work_shifts_open ON work_shifts(context) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_shift_members_shift ON work_shift_members(shift_id);
CREATE INDEX IF NOT EXISTS idx_work_shift_members_profile ON work_shift_members(profile_id);

ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS completed_by UUID REFERENCES profiles(id);
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS shift_id UUID REFERENCES work_shifts(id);

-- ── 3. Field pay rates ────────────────────────────────────────────────────

-- Keyed by the same string that lands in scan_logs.part_number — real part
-- numbers AND custom job names (e.g. "Uhaul Regular"). Flat per part: U-Haul
-- pay does not vary by vehicle type.
CREATE TABLE IF NOT EXISTS install_pay_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_number TEXT UNIQUE NOT NULL,
  rate_per_vehicle NUMERIC(10,2) NOT NULL,
  active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ── 4. Payouts + credits ──────────────────────────────────────────────────

-- Payout rows are generated in phase 3 (per-employee NetSuite bills for CNI,
-- biweekly payroll periods for field). Created now so credits can reference
-- and lock against them from day one.
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

-- The per-vehicle pay ledger: one row per crew member per completed vehicle,
-- snapshotting rate/weights/amount at completion time. Snapshots are the
-- source of truth — recomputes only happen as explicit admin actions, and
-- never on credits linked to a non-draft payout.
CREATE TABLE IF NOT EXISTS install_credits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID REFERENCES work_shifts(id) NOT NULL,
  profile_id UUID REFERENCES profiles(id) NOT NULL,
  -- What was completed (at least one):
  scan_log_id UUID REFERENCES scan_logs(id),
  cni_job_vin_id UUID REFERENCES cni_job_vins(id),
  vin TEXT,
  part_number TEXT,          -- denormalized for the needs-pricing queue/reports
  source TEXT NOT NULL CHECK (source IN ('cni', 'field')),
  -- Snapshot (NULL rate/amount = field scan with no configured rate yet):
  rate_per_vehicle NUMERIC(10,2),
  share_weight NUMERIC(6,2) NOT NULL DEFAULT 1,
  crew_size INT NOT NULL DEFAULT 1,
  total_weight NUMERIC(8,2) NOT NULL DEFAULT 1,
  amount NUMERIC(10,2),
  -- Payout linkage + audit:
  payout_id UUID REFERENCES payouts(id),
  voided_at TIMESTAMPTZ,
  voided_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  edited_by UUID REFERENCES profiles(id),
  edited_at TIMESTAMPTZ,
  CHECK (scan_log_id IS NOT NULL OR cni_job_vin_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_install_credits_profile ON install_credits(profile_id);
CREATE INDEX IF NOT EXISTS idx_install_credits_shift ON install_credits(shift_id);
CREATE INDEX IF NOT EXISTS idx_install_credits_scan ON install_credits(scan_log_id) WHERE scan_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_vin ON install_credits(cni_job_vin_id) WHERE cni_job_vin_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_unpriced ON install_credits(part_number) WHERE amount IS NULL AND voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_install_credits_payout ON install_credits(payout_id) WHERE payout_id IS NOT NULL;

-- ── 5. RLS ────────────────────────────────────────────────────────────────

-- The signed-in user's CNI company. SECURITY DEFINER so job policies can use
-- it without recursing into cni_profiles RLS; it only ever returns the
-- caller's own company.
CREATE OR REPLACE FUNCTION cni_user_company_id()
RETURNS UUID AS $$
  SELECT company_id FROM cni_profiles WHERE user_id = auth.uid()
$$ LANGUAGE sql SECURITY DEFINER STABLE;

ALTER TABLE cni_companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_shift_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pay_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admin full access to cni_companies" ON cni_companies FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
CREATE POLICY "Members can view own company" ON cni_companies FOR SELECT TO authenticated
  USING (id = cni_user_company_id());

-- Shifts, members, rates, payouts, and credits are written only via
-- service-role API routes (like scan_logs). Admin reads everything; users
-- read what they need for their own UI.
CREATE POLICY "Admin full access to work_shifts" ON work_shifts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
CREATE POLICY "Admin full access to work_shift_members" ON work_shift_members FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
CREATE POLICY "Admin full access to install_pay_rates" ON install_pay_rates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
CREATE POLICY "Admin full access to payouts" ON payouts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));
CREATE POLICY "Admin full access to install_credits" ON install_credits FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)) AND status = 'approved'));

-- Everyone sees their own money; crew composition comes through the API.
CREATE POLICY "Users can view own install_credits" ON install_credits FOR SELECT TO authenticated
  USING (profile_id = auth.uid());
CREATE POLICY "Users can view own payouts" ON payouts FOR SELECT TO authenticated
  USING (profile_id = auth.uid());

-- ── 6. Company-based job access ───────────────────────────────────────────
-- Additional permissive policies alongside the existing assigned-installer
-- ones: any installer at the assigned company gets the same access the
-- assigned installer has (no lead).

CREATE POLICY "Company members can view company cni_jobs" ON cni_jobs FOR SELECT TO authenticated
  USING (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id());
CREATE POLICY "Company members can update company cni_jobs" ON cni_jobs FOR UPDATE TO authenticated
  USING (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id())
  WITH CHECK (assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id());

CREATE POLICY "Company members can view cni_job_vins" ON cni_job_vins FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));
CREATE POLICY "Company members can update cni_job_vins" ON cni_job_vins FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

CREATE POLICY "Company members can upload cni_job_photos" ON cni_job_photos FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = auth.uid()
    AND EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id())
  );
CREATE POLICY "Company members can read cni_job_photos" ON cni_job_photos FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

CREATE POLICY "Company members can rw cni_job_messages" ON cni_job_messages FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

CREATE POLICY "Company members can view cni_job_status_history" ON cni_job_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_company_id IS NOT NULL AND assigned_company_id = cni_user_company_id()));

-- Company members may read each other's basic CNI profile rows (needed for
-- crew checklists and "who completed what" displays).
CREATE POLICY "Members can view company cni_profiles" ON cni_profiles FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());
