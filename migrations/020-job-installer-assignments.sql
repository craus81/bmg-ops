-- Migration 020: Multi-installer assignment for vehicles and graphics jobs
-- Supports assigning multiple users to a job with notification tracking

CREATE TABLE IF NOT EXISTS job_assignments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  -- What type of job
  job_type text NOT NULL CHECK (job_type IN ('scanned_vehicle', 'graphics_job')),
  job_id uuid NOT NULL,
  -- Who is assigned
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Metadata
  assigned_by uuid REFERENCES profiles(id),
  assigned_at timestamptz DEFAULT now(),
  notified boolean DEFAULT false,
  notified_at timestamptz,
  -- Prevent duplicate assignments
  UNIQUE(job_type, job_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_job_assignments_job ON job_assignments(job_type, job_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_user ON job_assignments(user_id);

-- RLS
ALTER TABLE job_assignments ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read assignments (needed for display)
CREATE POLICY "Authenticated users can read job assignments"
  ON job_assignments FOR SELECT
  TO authenticated
  USING (true);

-- Admin can manage all assignments
CREATE POLICY "Admin can manage job assignments"
  ON job_assignments FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Production can assign graphics jobs
CREATE POLICY "Production can assign graphics jobs"
  ON job_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    job_type = 'graphics_job'
    AND EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('production', 'admin')
    )
  );
