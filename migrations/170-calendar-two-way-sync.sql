-- Migration 170: two-way Google Calendar sync
-- The app has always pushed graphics install dates / upfit dates TO the
-- shared Google calendar; the calendar-pull cron now also reads FROM it.
-- Events created directly on Google land in calendar_events (source
-- 'google', no owning user), and manual FleetSuite events get pushed up
-- and remember their Google event id.

ALTER TABLE calendar_events
  ADD COLUMN IF NOT EXISTS google_event_id TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app';

-- Google-imported events have no FleetSuite owner.
ALTER TABLE calendar_events ALTER COLUMN user_id DROP NOT NULL;

-- Full (non-partial) unique index: the pull cron upserts ON CONFLICT
-- (google_event_id), which needs an exact-match index. NULLs don't
-- collide, so app-created rows without a Google id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_events_google_event
  ON calendar_events(google_event_id);

-- Cursor row for the pull cron (stores Google's incremental syncToken).
INSERT INTO sync_state (sync_type) VALUES ('google_calendar_pull')
ON CONFLICT DO NOTHING;
