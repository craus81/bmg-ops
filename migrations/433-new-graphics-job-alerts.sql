-- Migration 433: who hears about every new graphics job, beyond production.
--
-- PR #1288 (2026-10-24) took admins off the new-graphics-job alert so it
-- reaches graphics production and whoever is on the job. Craig, 2026-10-25:
-- "make sure Craig and Zach keep getting new graphics jobs notifications".
-- So it is an audience opt-in a super admin ticks per person in Admin →
-- Users → Edit → Settings, like Install-Ready Alerts.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS new_graphics_jobs BOOLEAN DEFAULT false;

COMMENT ON COLUMN notification_preferences.new_graphics_jobs IS
  'Gets the "New graphics job" alert for every job, not only jobs they are on (graphics production gets it by role).';

-- Tick it for Craig and Zach, each only when exactly one approved person
-- has that first name, so the migration can never pick the wrong person.
DO $$
DECLARE
  first_name TEXT;
  person UUID;
  n INT;
BEGIN
  FOREACH first_name IN ARRAY ARRAY['Craig', 'Zach'] LOOP
    SELECT count(*) INTO n FROM profiles
     WHERE full_name ILIKE first_name || ' %' AND status = 'approved';
    IF n = 1 THEN
      SELECT id INTO person FROM profiles
       WHERE full_name ILIKE first_name || ' %' AND status = 'approved';
      IF EXISTS (SELECT 1 FROM notification_preferences WHERE user_id = person) THEN
        UPDATE notification_preferences SET new_graphics_jobs = true WHERE user_id = person;
      ELSE
        INSERT INTO notification_preferences (user_id, new_graphics_jobs) VALUES (person, true);
      END IF;
    END IF;
  END LOOP;
END $$;
