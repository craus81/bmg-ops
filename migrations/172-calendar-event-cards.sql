-- Migration 172: schedule event cards (notes + files on calendar events)
-- Google-imported (and manual) schedule events become clickable cards on
-- /admin/schedule: staff can attach notes (with @mentions) and proof
-- files, and convert the card into a real graphics job. Converting links
-- the event to the job (linked_graphics_job_id) and carries the notes and
-- files over.

CREATE TABLE IF NOT EXISTS calendar_event_notes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  note TEXT NOT NULL,
  created_by UUID REFERENCES profiles(id),
  created_by_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_event_notes_event ON calendar_event_notes(event_id);

CREATE TABLE IF NOT EXISTS calendar_event_files (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES calendar_events(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_type TEXT,
  file_size BIGINT,
  storage_path TEXT NOT NULL,
  uploaded_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_event_files_event ON calendar_event_files(event_id);

-- Set when a card is converted into a graphics job; the schedule then
-- shows the job entry instead of the raw event.
ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS linked_graphics_job_id UUID REFERENCES graphics_jobs(id) ON DELETE SET NULL;

ALTER TABLE calendar_event_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_event_files ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_event_notes_all ON calendar_event_notes;
CREATE POLICY calendar_event_notes_all ON calendar_event_notes
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());

DROP POLICY IF EXISTS calendar_event_files_all ON calendar_event_files;
CREATE POLICY calendar_event_files_all ON calendar_event_files
  FOR ALL TO authenticated
  USING (public.is_internal_staff())
  WITH CHECK (public.is_internal_staff());
