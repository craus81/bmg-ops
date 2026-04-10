-- Migration 062: Manual calendar events

CREATE TABLE IF NOT EXISTS calendar_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_date DATE NOT NULL,
  event_time TIME,
  duration_minutes INTEGER DEFAULT 60,
  event_type TEXT DEFAULT 'meeting' CHECK (event_type IN ('meeting', 'call', 'reminder', 'deadline', 'other')),
  -- Who this event belongs to
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  -- Optional link to a prospect/customer
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(event_date);
CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id);

ALTER TABLE calendar_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their own events" ON calendar_events FOR ALL TO authenticated
  USING (user_id = auth.uid() OR public.is_internal_staff())
  WITH CHECK (user_id = auth.uid() OR public.is_internal_staff());
