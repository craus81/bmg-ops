-- 272: A/R history capture (R5-1, Tier 2 days-to-pay item — the
-- capture-before-reporting half; history cannot be backfilled).
--
-- paid_at: stamped by the 2-hourly AR sweep the moment it flips is_paid —
-- i.e. when the sweep NOTICED NetSuite say Paid In Full, not the payment's
-- posting date (readers must label it that way; true payment dates come
-- from the financials RESTlet per customer). NULL = paid before this
-- shipped, or ticked by hand in the UI — date unknown.
ALTER TABLE fleet_checkins ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
COMMENT ON COLUMN fleet_checkins.paid_at IS
  'When the AR sweep noticed the invoice Paid In Full (not the payment date). NULL = pre-capture or manual tick.';
COMMENT ON COLUMN scan_logs.paid_at IS
  'When the AR sweep noticed the invoice Paid In Full (not the payment date). NULL = pre-capture or manual tick.';

-- Nightly A/R snapshots: open-AR total, per aging bucket, and the top open
-- customers — the same computeArAging numbers the Financials tab shows,
-- persisted so "is our A/R getting better or worse" becomes answerable.
-- Written by the metric-snapshots cron; upsert per (day, scope, key).
CREATE TABLE IF NOT EXISTS ar_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day DATE NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('total', 'bucket', 'customer')),
  -- 'total' | bucket key (current/d1_30/...) | arCustomerKey (e:<id> / n:<name>)
  key TEXT NOT NULL,
  label TEXT,                       -- display name for customer rows
  value NUMERIC(14,2) NOT NULL,     -- open A/R dollars
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (day, scope, key)
);
CREATE INDEX IF NOT EXISTS idx_ar_snapshots_day ON ar_snapshots(day);
ALTER TABLE ar_snapshots ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only, same posture as metric_snapshots.

-- Every AR sweep run, persisted instead of discarded — how many invoices
-- were checked, how many came back paid, how many rows flipped.
CREATE TABLE IF NOT EXISTS ar_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual'
  checked_invoices INTEGER NOT NULL DEFAULT 0,
  paid_invoices INTEGER NOT NULL DEFAULT 0,
  fleet_checkins_updated INTEGER NOT NULL DEFAULT 0,
  scan_logs_updated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ar_sync_runs_run_at ON ar_sync_runs(run_at DESC);
ALTER TABLE ar_sync_runs ENABLE ROW LEVEL SECURITY;
