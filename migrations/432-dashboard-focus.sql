-- Migration 432: each person's Dashboard focus.
--
-- Craig, 2026-10-24 (thread "Simplify dashboards and notifications"): the
-- Dashboard was the same 13 cards for everyone and staff were overwhelmed.
-- A super admin now picks what each person's Dashboard is about in Admin →
-- Users → Edit → Settings. Values (src/lib/dashboard-focus.ts):
-- 'everything', 'sales', 'financial', 'scheduling', 'purchasing'. NULL =
-- follow the role (admins everything, sales sales, finance/exec financial).
-- Not a privilege column: it changes what the Dashboard shows first, never
-- what anyone can open.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS dashboard_focus TEXT[];

COMMENT ON COLUMN profiles.dashboard_focus IS
  'Dashboard focus picked by a super admin (everything, sales, financial, scheduling, purchasing). NULL = from the role.';

-- Craig's picks for the current staff. Each is set only when exactly one
-- approved person has that first name and nobody has picked a focus for
-- them yet, so the migration can never hit the wrong person or undo a
-- choice. Zach, Ashley and Craig are admins, whose default is Everything.
DO $$
DECLARE
  pick RECORD;
  n INT;
BEGIN
  FOR pick IN
    SELECT * FROM (VALUES
      ('Valarie', ARRAY['sales']::TEXT[]),
      ('Harold', ARRAY['financial']::TEXT[]),
      ('Jessie', ARRAY['scheduling', 'purchasing']::TEXT[])
    ) AS t(first_name, focus)
  LOOP
    SELECT count(*) INTO n FROM profiles
     WHERE full_name ILIKE pick.first_name || ' %' AND status = 'approved';
    IF n = 1 THEN
      UPDATE profiles SET dashboard_focus = pick.focus
       WHERE full_name ILIKE pick.first_name || ' %' AND status = 'approved'
         AND dashboard_focus IS NULL;
    END IF;
  END LOOP;
END $$;
