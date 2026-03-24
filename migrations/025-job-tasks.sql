-- Job tasks / checklist items for installers
-- Run in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS job_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL,
  label TEXT NOT NULL,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES auth.users(id),
  completed_by_name TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast lookup by job
CREATE INDEX IF NOT EXISTS idx_job_tasks_job_id ON job_tasks(job_id);

-- RLS
ALTER TABLE job_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read job tasks"
  ON job_tasks FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert job tasks"
  ON job_tasks FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update job tasks"
  ON job_tasks FOR UPDATE
  TO authenticated
  USING (true);
