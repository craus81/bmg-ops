-- Migration 270: nightly executive metric snapshots (Round 4 / R4-1).
--
-- Every financial and operational number in the app is a live read that
-- evaporates at midnight — there is no A/R-over-time, no backlog trend, no
-- cash trend, and history can never be backfilled. This table is the memory:
-- one row per metric per (America/Chicago) day, written by the
-- metric-snapshots cron, read by the CEO view's sparklines and trend charts.
--
-- value is NULLABLE on purpose: when a source errors (the financials RESTlet
-- being the usual suspect) the cron records NULL with the error in meta —
-- recording 0 instead would make every trend chart lie on bad days.

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  metric TEXT NOT NULL,
  day DATE NOT NULL,
  value NUMERIC(16,2),
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (metric, day)
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_metric_day
  ON metric_snapshots(metric, day DESC);

-- Service-role only: financial data, mediated by executive-gated APIs.
-- RLS on with no policies = signed-in clients read nothing; the service
-- role bypasses RLS.
ALTER TABLE metric_snapshots ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE metric_snapshots IS
  'Migration 270 (R4-1): one row per executive metric per Chicago day, written nightly by /api/cron/metric-snapshots. value NULL = source errored that day (see meta), deliberately distinct from 0.';
