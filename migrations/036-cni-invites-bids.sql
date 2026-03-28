-- Migration 036: CNI Job Invites & Bids
-- Phase 2 of CNI — Distribution & Scheduling

-- ─────────────────────────────────────────
-- Table: cni_job_invites
-- Tracks which installers were invited to a job
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cni_job_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  installer_id UUID REFERENCES profiles(id) NOT NULL,
  invite_type TEXT NOT NULL DEFAULT 'direct',  -- direct, published
  invited_by UUID REFERENCES profiles(id),
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  seen_at TIMESTAMPTZ,
  UNIQUE(job_id, installer_id)
);

CREATE INDEX idx_cni_job_invites_job ON cni_job_invites(job_id);
CREATE INDEX idx_cni_job_invites_installer ON cni_job_invites(installer_id);

-- RLS
ALTER TABLE cni_job_invites ENABLE ROW LEVEL SECURITY;

-- Admin: full CRUD
CREATE POLICY "admin_full_cni_job_invites" ON cni_job_invites
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

-- Installers: read own invites
CREATE POLICY "installer_read_own_invites" ON cni_job_invites
  FOR SELECT USING (installer_id = auth.uid());


-- ─────────────────────────────────────────
-- Table: cni_job_bids
-- Installer responses to job invites/listings
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cni_job_bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  installer_id UUID REFERENCES profiles(id) NOT NULL,

  -- Response
  response TEXT NOT NULL CHECK (response IN ('interested', 'declined')),
  decline_reason TEXT,

  -- If interested
  proposed_start DATE,
  proposed_end DATE,
  notes TEXT,

  responded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(job_id, installer_id)
);

CREATE INDEX idx_cni_job_bids_job ON cni_job_bids(job_id);
CREATE INDEX idx_cni_job_bids_installer ON cni_job_bids(installer_id);

-- RLS
ALTER TABLE cni_job_bids ENABLE ROW LEVEL SECURITY;

-- Admin: full access
CREATE POLICY "admin_full_cni_job_bids" ON cni_job_bids
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND (role = 'admin' OR 'admin' = ANY(roles)))
  );

-- Installers: create + read own bids
CREATE POLICY "installer_create_own_bids" ON cni_job_bids
  FOR INSERT WITH CHECK (installer_id = auth.uid());

CREATE POLICY "installer_read_own_bids" ON cni_job_bids
  FOR SELECT USING (installer_id = auth.uid());
