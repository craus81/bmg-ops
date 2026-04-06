-- Migration: Add scheduled_upfit_date and matched_graphics_job_id to fleet_checkins
-- Also add calendar_event_id for Google Calendar sync

ALTER TABLE fleet_checkins
ADD COLUMN IF NOT EXISTS scheduled_upfit_date DATE;

ALTER TABLE fleet_checkins
ADD COLUMN IF NOT EXISTS matched_graphics_job_id UUID REFERENCES graphics_jobs(id);

ALTER TABLE fleet_checkins
ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
