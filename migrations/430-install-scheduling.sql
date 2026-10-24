-- Migration 430: who schedules installs, and the install confirmation.
--
-- Valarie's process note (2026-10-23, thread "Notify production and
-- scheduling on approval"): when a customer approves a proof, Brian prints
-- it and Jessie calls the client to set the install date and put it on the
-- install calendar; then the client and the rep get an install
-- confirmation. Craig's picks (2026-10-24): a "Schedules installs" tick on
-- the person (Jessie only for now) that brings the "Schedule install" alert
-- and the Home list, and a staff button that sends the confirmation (never
-- automatic).

-- Audience opt-in, set by a super admin in Admin → Users → Edit → Settings.
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS schedules_installs BOOLEAN DEFAULT false;

COMMENT ON COLUMN notification_preferences.schedules_installs IS
  'This person sets install dates: gets the "Schedule install" alert when a customer approves a proof on an installed job, and the "Needs install date" list on Home.';

-- Arrival time shown on the confirmation ("8:00 AM"), free text since the
-- calendar entry stays all-day. And when the confirmation last went out.
ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS install_arrival_time TEXT,
  ADD COLUMN IF NOT EXISTS install_confirmation_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS install_confirmation_sent_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Tick it for Jessie, only when exactly one approved Jessie exists, so the
-- migration can never pick the wrong person. Anyone can be changed later
-- from the Users screen.
DO $$
DECLARE
  jessie UUID;
  n INT;
BEGIN
  SELECT count(*) INTO n FROM profiles
   WHERE full_name ILIKE 'Jessie %' AND status = 'approved';
  IF n = 1 THEN
    SELECT id INTO jessie FROM profiles
     WHERE full_name ILIKE 'Jessie %' AND status = 'approved';
    IF EXISTS (SELECT 1 FROM notification_preferences WHERE user_id = jessie) THEN
      UPDATE notification_preferences SET schedules_installs = true WHERE user_id = jessie;
    ELSE
      INSERT INTO notification_preferences (user_id, schedules_installs) VALUES (jessie, true);
    END IF;
  END IF;
END $$;
