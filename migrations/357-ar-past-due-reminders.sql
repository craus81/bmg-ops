-- Past-due invoice reminders for A/R (owner decisions 2026-10-09).
--
-- The weekday-morning sweep (/api/cron/ar-past-due) reads open invoices from
-- NetSuite and alerts the A/R contact once when an invoice reaches each step
-- (1, 15, 30, 60 days past its due date by default), in one digest that
-- links to /invoices/past-due. Customers are never emailed automatically:
-- staff pick customers on that page and send a statement themselves.
--
-- ar_reminder_settings — singleton, same shape as graphics_reminder_settings
-- (migration 319): staff read it, admins write it. recipient_ids is who gets
-- the digest; it starts as Jessie Whittington when her profile exists.
--
-- ar_reminder_log — one row per (invoice, step) already alerted, so a step
-- alerts exactly once however many times the sweep runs. Written by the
-- service role only.

CREATE TABLE IF NOT EXISTS ar_reminder_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  step_days INTEGER[] NOT NULL DEFAULT '{1,15,30,60}',
  recipient_ids UUID[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ,
  updated_by UUID REFERENCES profiles(id)
);

INSERT INTO ar_reminder_settings (id, recipient_ids)
SELECT 1, COALESCE(
  (SELECT ARRAY[id] FROM profiles WHERE id = '13c993b2-bb84-4539-8bbc-6c85395f558c'),
  '{}'::uuid[]
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE ar_reminder_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS ar_reminder_log (
  -- NetSuite invoice internal id.
  invoice_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  tranid TEXT,
  entity_id TEXT,
  customer TEXT,
  days_past_due INTEGER,
  amount NUMERIC(12, 2),
  alerted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (invoice_id, step)
);

CREATE INDEX IF NOT EXISTS ar_reminder_log_entity_idx ON ar_reminder_log (entity_id);

ALTER TABLE ar_reminder_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff can read AR reminder settings' AND tablename = 'ar_reminder_settings'
  ) THEN
    CREATE POLICY "Staff can read AR reminder settings" ON ar_reminder_settings
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Admins can manage AR reminder settings' AND tablename = 'ar_reminder_settings'
  ) THEN
    CREATE POLICY "Admins can manage AR reminder settings" ON ar_reminder_settings
      FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff can read AR reminder log' AND tablename = 'ar_reminder_log'
  ) THEN
    CREATE POLICY "Staff can read AR reminder log" ON ar_reminder_log
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;
