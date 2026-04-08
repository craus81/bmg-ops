-- Migration 054: Sales cadences — configurable follow-up schedules for prospects

-- Cadence templates (e.g., Aggressive, Monthly Check-in, New Lead)
CREATE TABLE IF NOT EXISTS sales_cadences (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  -- Interval in days between follow-ups
  interval_days INTEGER NOT NULL DEFAULT 7,
  -- Number of follow-ups before cadence completes (null = infinite)
  max_steps INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Prospect cadence assignments (which prospect is on which cadence)
CREATE TABLE IF NOT EXISTS prospect_cadence_assignments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  cadence_id UUID NOT NULL REFERENCES sales_cadences(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES profiles(id),
  started_at TIMESTAMPTZ DEFAULT now(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  current_step INTEGER DEFAULT 0,
  next_due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  UNIQUE(prospect_id, cadence_id)
);

CREATE INDEX IF NOT EXISTS idx_cadence_assignments_prospect ON prospect_cadence_assignments(prospect_id);
CREATE INDEX IF NOT EXISTS idx_cadence_assignments_due ON prospect_cadence_assignments(next_due_at) WHERE status = 'active';

-- RLS
ALTER TABLE sales_cadences ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_cadence_assignments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage cadences" ON sales_cadences FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
CREATE POLICY "Internal staff can manage cadence assignments" ON prospect_cadence_assignments FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

-- Seed default cadences
INSERT INTO sales_cadences (name, description, interval_days, max_steps) VALUES
  ('Aggressive', 'Follow up every 3 days — for hot leads', 3, 10),
  ('Weekly', 'Weekly check-in for active opportunities', 7, 8),
  ('Bi-Weekly', 'Every two weeks — moderate follow-up', 14, 6),
  ('Monthly', 'Monthly touchpoint for long-term nurturing', 30, NULL)
ON CONFLICT DO NOTHING;
