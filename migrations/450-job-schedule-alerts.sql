-- Migration 450: tell whoever schedules installs when a job's parts are
-- ready, and copy Craig on new alerts.
--
-- Craig (2026-10-28, thread "Explain what ready to schedule triggers"): the
-- job page's "All parts reserved — ready to schedule" banner was only a
-- label. Now whoever has "Schedules installs" ticked (Jessie) hears about it
-- in two steps:
--   1. Parts are in stock but not reserved → "Check the stock and reserve".
--   2. Every part reserved and no drop-off date → "Ready to schedule".
-- Each step is sent once per job; the job remembers the last one here so a
-- sweep can't repeat it. The step clears when the job no longer qualifies,
-- so a job that slips back (a release, a short part) can alert again.
ALTER TABLE upfit_projects
  ADD COLUMN IF NOT EXISTS schedule_alert_step TEXT,
  ADD COLUMN IF NOT EXISTS schedule_alert_at TIMESTAMPTZ;

COMMENT ON COLUMN upfit_projects.schedule_alert_step IS
  'Last scheduling alert sent for this job: reserve (parts in stock, not reserved) or schedule (all reserved, no drop-off date). Null once neither applies.';

-- "Everything we build should include me in the alerts so I can see how
-- things are working" (Craig, 2026-10-28). An audience opt-in on the person,
-- set in Admin → Users → Edit → Settings; new alert types add these people
-- on top of their normal audience.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS copy_new_alerts BOOLEAN DEFAULT false;

COMMENT ON COLUMN notification_preferences.copy_new_alerts IS
  'Copied on newly built alerts (on top of their normal audience) to watch how they work. Craig at first.';

-- Tick it for Craig, only when exactly one approved Craig exists, so the
-- migration can never pick the wrong person.
DO $$
DECLARE
  craig UUID;
  n INT;
BEGIN
  SELECT count(*) INTO n FROM profiles
   WHERE full_name ILIKE 'Craig %' AND status = 'approved';
  IF n = 1 THEN
    SELECT id INTO craig FROM profiles
     WHERE full_name ILIKE 'Craig %' AND status = 'approved';
    IF EXISTS (SELECT 1 FROM notification_preferences WHERE user_id = craig) THEN
      UPDATE notification_preferences SET copy_new_alerts = true WHERE user_id = craig;
    ELSE
      INSERT INTO notification_preferences (user_id, copy_new_alerts) VALUES (craig, true);
    END IF;
  END IF;
END $$;
