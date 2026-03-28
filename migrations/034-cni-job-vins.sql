-- CNI Job VINs: Per-VIN tracking within multi-unit CNI jobs
-- Each VIN has its own completion status and photo tracking

CREATE TABLE IF NOT EXISTS cni_job_vins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  vin TEXT NOT NULL,
  vehicle_year TEXT,
  vehicle_make TEXT,
  vehicle_model TEXT,

  -- Per-VIN status
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
  completed_at TIMESTAMPTZ,
  completion_notes TEXT,

  -- Photo tracking
  photos_submitted BOOLEAN DEFAULT FALSE,
  photos_approved BOOLEAN DEFAULT FALSE,
  photo_review_notes TEXT,

  sort_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cni_job_vins_job_id ON cni_job_vins(job_id);
CREATE INDEX IF NOT EXISTS idx_cni_job_vins_status ON cni_job_vins(status);

-- RLS
ALTER TABLE cni_job_vins ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "Admin full access to cni_job_vins"
  ON cni_job_vins FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

-- Installers can view VINs on their assigned jobs
CREATE POLICY "Installers can view cni_job_vins on assigned jobs"
  ON cni_job_vins FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid())
  );

-- Installers can update VINs on their assigned jobs (mark complete, add notes)
CREATE POLICY "Installers can update cni_job_vins on assigned jobs"
  ON cni_job_vins FOR UPDATE
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid())
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid())
  );
