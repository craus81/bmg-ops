-- Migration 298: CNI job P&L card (R6-8)
--
-- The job console can now total revenue against installer cost, so the
-- coordinator can be told the moment committed cost crosses the job's budget
-- -- mid-job, while there is still something to do about it, rather than
-- when the numbers are read at closure.
--
-- The alert fires ONCE per budget: a job that goes over stays over, and
-- re-alerting every sweep on a fact the coordinator already knows is how the
-- alert gets muted.
--
-- Two columns, not one. Recording WHICH budget was alerted on makes the
-- re-arm automatic: raise the budget and the stored amount no longer matches,
-- so a re-scoped job warns again against its new number without anything
-- having to remember to clear a flag. (The compliance ladder keys on the
-- expiry date for exactly the same reason -- a stamp that only says "already
-- told them" goes wrong the moment the underlying number changes.)
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS budget_alerted_at TIMESTAMPTZ;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS budget_alerted_amount NUMERIC(12,2);

COMMENT ON COLUMN cni_jobs.budget_alerted_at IS
  'Migration 298: when the CNI sweep told the coordinator committed installer cost had crossed this job''s budget.';
COMMENT ON COLUMN cni_jobs.budget_alerted_amount IS
  'Migration 298: the budget that alert was about. The sweep stays quiet only while this still equals cni_jobs.budget, so raising the budget re-arms the warning by itself.';
