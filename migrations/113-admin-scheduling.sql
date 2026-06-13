-- Admin-driven scheduling (replaces the installer-proposes handshake).
--
-- New flow: the admin proposes a start date+time; the installer accepts or
-- declines; the admin may also accept on the installer's behalf (verbal
-- commitment). One datetime column holds the proposed/confirmed start so we
-- can carry a time, not just a date (the legacy proposed_/confirmed_schedule_*
-- DATE columns stay for historical jobs).

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ;     -- optional window / multi-day
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS schedule_decline_note TEXT;       -- installer's reason when declining
