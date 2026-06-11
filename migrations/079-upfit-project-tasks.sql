-- Migration 075: Tasks on upfit projects
-- Each task belongs to an upfit project, can be assigned to a single profile,
-- has an optional due date, and is toggled complete via completed_at timestamp.

CREATE TABLE IF NOT EXISTS upfit_project_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  description TEXT,

  assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
  due_date DATE,

  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,

  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_upfit_tasks_project ON upfit_project_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_upfit_tasks_assigned ON upfit_project_tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_upfit_tasks_due ON upfit_project_tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_upfit_tasks_open ON upfit_project_tasks(project_id) WHERE completed_at IS NULL;

ALTER TABLE upfit_project_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "upfit_project_tasks_select" ON upfit_project_tasks FOR SELECT USING (true);
CREATE POLICY "upfit_project_tasks_insert" ON upfit_project_tasks FOR INSERT WITH CHECK (true);
CREATE POLICY "upfit_project_tasks_update" ON upfit_project_tasks FOR UPDATE USING (true);
CREATE POLICY "upfit_project_tasks_delete" ON upfit_project_tasks FOR DELETE USING (true);
