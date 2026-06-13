-- Companies + per-vehicle pay splits (phase 1 of docs/pay-splits-design.md)
--
-- CNI jobs move from a single assigned installer to an assigned COMPANY: any
-- installer at the company can schedule, scan, and complete work. Crews are
-- tagged per shift, and every completed vehicle snapshots a per-member pay
-- credit (rate × weight / Σ weights). Field (/scan) installs get the same
-- shift + credit mechanics with rates from install_pay_rates.

-- ── 1. Companies ──────────────────────────────────────────────────────────
-- CNI uses the EXISTING `companies` table (the one assigned to users at
-- access-granting time via profiles.company_id) — there is no separate CNI
-- company list. A CNI company's installers are simply the profiles whose
-- company_id points at it. Here we add the CNI-specific fields companies
-- needs for assignment, payouts, and compliance.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS primary_contact_profile_id UUID REFERENCES profiles(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS address JSONB DEFAULT '{}'::jsonb;
-- Company-level vendor for the lump-sum payout mode (phase 3).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS netsuite_vendor_id TEXT;
-- Company-level compliance docs (per-person docs stay on cni_profiles).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS w9_file_path TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS insurance_cert_path TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS insurance_expiry DATE;

-- Per-person vendor for individual payouts (phase 3).
ALTER TABLE cni_profiles ADD COLUMN IF NOT EXISTS netsuite_vendor_id TEXT;

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS assigned_company_id UUID REFERENCES companies(id);
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS pay_per_vehicle NUMERIC(10,2);

-- Curated field crew picker ("field installer" flag on internal profiles;
-- field_tech-role users are included by the roster query regardless).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_field_installer BOOLEAN DEFAULT FALSE;

-- Map open jobs to the assigned installer's company (profiles.company_id).
-- Closed jobs are left installer-only on purpose: visibility broadens for
-- new/active work only.
UPDATE cni_jobs j
SET assigned_company_id = p.company_id
FROM profiles p
WHERE j.assigned_company_id IS NULL
  AND j.assigned_installer_id IS NOT NULL
  AND j.status <> 'approved_closed'
  AND p.id = j.assigned_installer_id
  AND p.company_id IS NOT NULL;

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

-- The signed-in user's company, straight from their profile. SECURITY
-- DEFINER so job policies can use it without tripping profiles RLS; it only
-- ever returns the caller's own company. search_path is pinned and the table
-- schema-qualified so the function resolves under the hardened (empty)
-- search_path that SECURITY DEFINER functions run with.
CREATE OR REPLACE FUNCTION cni_user_company_id()
RETURNS UUID
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM public.profiles WHERE id = auth.uid()
$$;

ALTER TABLE work_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_shift_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_pay_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE install_credits ENABLE ROW LEVEL SECURITY;

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

-- Company members may read each other's profile rows (crew checklists and
-- "who completed what" displays). Crew rosters themselves are assembled
-- server-side via the service role, so this only covers client-side reads.
CREATE POLICY "Members can view company profiles" ON profiles FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());
