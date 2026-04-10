-- Migration 061: Prospect reminders from AI-parsed voice notes

CREATE TABLE IF NOT EXISTS prospect_reminders (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  activity_id UUID REFERENCES prospect_activities(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  description TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_reminders_due ON prospect_reminders(due_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prospect_reminders_prospect ON prospect_reminders(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospect_reminders_user ON prospect_reminders(created_by) WHERE completed_at IS NULL;

ALTER TABLE prospect_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage reminders" ON prospect_reminders FOR ALL TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
