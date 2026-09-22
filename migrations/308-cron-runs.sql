-- Migration 308: cron flight recorder (R6-13).
--
-- System Health has always shown ONE data point per job — how stale its
-- sync_state row is. That answers "is it running?" and nothing else: a job
-- that has quietly taken 4× longer every night for a week, or processed
-- zero records for three days while still reporting success, looks
-- identical to a healthy one.
--
-- recordHeartbeat() is the single funnel every background job already goes
-- through, so appending a row there captures every run without touching 27
-- crons.
--
-- WHAT AN ABSENT ROW MEANS. Only runs that REACH recordHeartbeat land here.
-- A run that crashed before it, or was never scheduled, leaves no row —
-- so a gap in this history is not evidence a job failed, only that it did
-- not finish reporting. Staleness in sync_state remains the signal for
-- "did it run at all"; this table is for "how did the runs that finished
-- actually go".
--
-- duration_ms and records are NULLABLE and nullable on purpose: a caller
-- that did not pass a start time genuinely does not know how long it took,
-- and a job with no countable output has no record count. Storing 0 for
-- either would read as "instant" and "processed nothing", both of which
-- are claims the data does not support.

CREATE TABLE IF NOT EXISTS cron_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_type TEXT NOT NULL,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  records INTEGER,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_type_time
  ON cron_runs(sync_type, finished_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_time
  ON cron_runs(finished_at DESC);

COMMENT ON TABLE cron_runs IS 'One row per background-job run that reached recordHeartbeat (R6-13). A gap means the run never finished reporting, not that the job is fine.';
COMMENT ON COLUMN cron_runs.duration_ms IS 'NULL when the caller did not pass a start time — unknown, not instant.';
COMMENT ON COLUMN cron_runs.records IS 'NULL when the run reported no countable output — unknown, not zero.';

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

-- Staff read (System Health is staff-visible); writes are service-role only,
-- which is how every heartbeat already reaches sync_state.
DROP POLICY IF EXISTS cron_runs_select ON cron_runs;
CREATE POLICY cron_runs_select ON cron_runs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid()
        AND COALESCE(p.deactivated, false) = false
        AND NOT (COALESCE(p.roles, ARRAY[p.role]) <@ ARRAY['customer']::text[])
    )
  );
