-- CNI Job Status History: Audit trail for every status change on a CNI job

CREATE TABLE IF NOT EXISTS cni_job_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID REFERENCES cni_jobs(id) ON DELETE CASCADE NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by UUID REFERENCES profiles(id),
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cni_job_status_history_job_id ON cni_job_status_history(job_id);
CREATE INDEX IF NOT EXISTS idx_cni_job_status_history_created_at ON cni_job_status_history(created_at);

-- RLS
ALTER TABLE cni_job_status_history ENABLE ROW LEVEL SECURITY;

-- Admin full access
CREATE POLICY "Admin full access to cni_job_status_history"
  ON cni_job_status_history FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

-- Installers can view history on their assigned jobs
CREATE POLICY "Installers can view cni_job_status_history on assigned jobs"
  ON cni_job_status_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid())
  );

-- Anyone authenticated can insert status history (triggered by status changes)
CREATE POLICY "Authenticated users can insert cni_job_status_history"
  ON cni_job_status_history FOR INSERT
  TO authenticated
  WITH CHECK (changed_by = auth.uid());

-- Auto-log status changes via trigger
CREATE OR REPLACE FUNCTION log_cni_job_status_change()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO cni_job_status_history (job_id, from_status, to_status, changed_by)
    VALUES (NEW.id, OLD.status, NEW.status, auth.uid());
  END IF;
  -- Also update the updated_at timestamp
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_cni_job_status_change
  BEFORE UPDATE ON cni_jobs
  FOR EACH ROW
  EXECUTE FUNCTION log_cni_job_status_change();
