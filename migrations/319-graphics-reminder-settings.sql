-- Reminders for graphics jobs that have gone quiet.
--
-- The board already shows this — Overdue, Due in 7 days, Stuck 5+ days in
-- stage — but showing only reaches someone already looking at the board,
-- and a job stalls precisely when nobody is. The daily sweep
-- (/api/cron/graphics-reminders) turns those same questions into one digest
-- per person, so this table is what admins tune it with.
--
-- Per-stage thresholds rather than one number, because one number is wrong
-- twice: outgassing is legitimately an overnight wait (a flat 2-day rule
-- nags the print room about physics), while a week in Designing is a lost
-- job the same rule forgives. stage_days is a status → days map; 0 or a
-- missing key turns that stage off, which is how ready_to_pickup ships —
-- a job waiting on the CUSTOMER to collect it is not the designer's to
-- hurry.
--
-- Singleton row, same shape as quote_settings (migration 150): staff read
-- it, admins write it. The cron reads through the service role, so a
-- missing row is not an outage — resolveReminderSettings() falls back to
-- the defaults in src/lib/graphics-reminders.ts.

CREATE TABLE IF NOT EXISTS graphics_reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- { "designing": 3, "printing": 1, ... } — days in stage before stalled.
  stage_days JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Warn this many days before a due date.
  due_soon_days INTEGER NOT NULL DEFAULT 2,
  -- An active job with nobody on it for this long needs an owner.
  unassigned_days INTEGER NOT NULL DEFAULT 1,
  -- Extra days past a reason's own threshold before the person who entered
  -- the job and the super admins are told too.
  escalate_after_days INTEGER NOT NULL DEFAULT 3,
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES profiles(id)
);

INSERT INTO graphics_reminder_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE graphics_reminder_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff can read graphics reminder settings'
      AND tablename = 'graphics_reminder_settings'
  ) THEN
    CREATE POLICY "Staff can read graphics reminder settings" ON graphics_reminder_settings
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Admins can manage graphics reminder settings'
      AND tablename = 'graphics_reminder_settings'
  ) THEN
    CREATE POLICY "Admins can manage graphics reminder settings" ON graphics_reminder_settings
      FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
END $$;
