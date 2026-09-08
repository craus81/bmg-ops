-- Migration 294: Month-End Close Cockpit (R6-12)
--
-- One page per accounting month with pass/fail gates: is everything that
-- was finished in the month actually billed, is the AP/payout pipeline
-- drained, did any money email bounce and never get fixed, and have the
-- checks that need a person's eyes (NetSuite reconciliation, invoice
-- location backfill) actually been done.
--
-- Two things need storing for that to be more than a dashboard:
--
--  1. Sign-offs. A gate the app cannot compute (anything that lives in
--     NetSuite) is PENDING until a person says they checked it, and a
--     computed gate that fails can be WAIVED with a written reason. A
--     waiver never turns a fail into a pass — it records who accepted it.
--  2. The close stamp, WITH a snapshot of what the gates said at that
--     moment. Re-opening a closed month a year later must show what was
--     true when it closed, not a recomputation against data that has
--     moved on underneath it.
--
-- Idempotent: preview builds skip migrations and a re-deploy re-runs them.

-- Period is 'YYYY-MM' (America/Chicago calendar months — the same shop
-- calendar exec-metrics snapshots on).
CREATE TABLE IF NOT EXISTS month_close_gate_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period TEXT NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  gate_key TEXT NOT NULL,
  -- 'acknowledged' = a person checked a gate the app can't compute.
  -- 'waived'       = a person accepted a FAILING computed gate, with a reason.
  kind TEXT NOT NULL CHECK (kind IN ('acknowledged', 'waived')),
  note TEXT,
  signed_by UUID REFERENCES profiles(id),
  signed_by_name TEXT,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period, gate_key)
);

CREATE INDEX IF NOT EXISTS idx_month_close_signoffs_period
  ON month_close_gate_signoffs(period);

COMMENT ON TABLE month_close_gate_signoffs IS
  'Migration 294: per-(period, gate) sign-off for the month-end close cockpit. kind=acknowledged for a gate the app cannot compute; kind=waived for a failing computed gate a person accepted. A waiver records acceptance — it does NOT make the gate pass.';

CREATE TABLE IF NOT EXISTS month_close_periods (
  period TEXT PRIMARY KEY CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  closed_by UUID REFERENCES profiles(id),
  closed_by_name TEXT,
  closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT,
  -- What every gate said at the moment of closing. A closed month renders
  -- from this, never from a fresh recomputation.
  gate_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  reopened_by UUID REFERENCES profiles(id),
  reopened_at TIMESTAMPTZ
);

COMMENT ON TABLE month_close_periods IS
  'Migration 294: the month-end close stamp. gate_snapshot freezes what every gate said when the month was closed, so a closed month never re-renders against data that moved on. A row with reopened_at set is no longer closed.';

ALTER TABLE month_close_gate_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE month_close_periods ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff manage close signoffs' AND tablename = 'month_close_gate_signoffs') THEN
    CREATE POLICY "Internal staff manage close signoffs" ON month_close_gate_signoffs
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff manage close periods' AND tablename = 'month_close_periods') THEN
    CREATE POLICY "Internal staff manage close periods" ON month_close_periods
      FOR ALL TO authenticated
      USING (public.is_internal_staff())
      WITH CHECK (public.is_internal_staff());
  END IF;
END $$;

-- The bounced-money-email gate needs a way to say "handled". Until now a
-- bounce stayed bounced forever, so a gate counting them could only ever
-- fail once anything had ever bounced.
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES profiles(id);
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS resolution_note TEXT;

COMMENT ON COLUMN email_log.resolved_at IS
  'Migration 294: set when someone fixed the contact and/or re-sent after a bounce/complaint/failure. Unresolved money-email bounces block the month-end close.';

-- The close cockpit scans the period for unresolved bounces; the partial
-- index keeps that a cheap read as the log grows.
CREATE INDEX IF NOT EXISTS idx_email_log_unresolved_failures
  ON email_log(created_at DESC)
  WHERE resolved_at IS NULL
    AND delivery_status IN ('bounced', 'complained', 'failed');
