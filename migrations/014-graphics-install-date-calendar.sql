-- Migration 014: Graphics install date + Google Calendar sync
-- Adds scheduled install date and calendar event tracking to graphics jobs

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS scheduled_install_date DATE,
  ADD COLUMN IF NOT EXISTS calendar_event_id TEXT; -- Google Calendar event ID for sync

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_install_date ON graphics_jobs(scheduled_install_date);

-- Update the google_tokens scope to include calendar
-- (This is informational — the actual scope change happens in code)
COMMENT ON TABLE google_tokens IS 'Stores Google OAuth tokens. Scopes: gmail.readonly, calendar';
