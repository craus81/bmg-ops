-- Admin-controlled work order for the graphics board.
--
-- The board already had a priority bucket (low/normal/high/rush) and a due
-- date, and neither answered the question the designer and production
-- manager actually ask every morning: of the eight jobs that are all "high"
-- and all due this week, which one do I touch first? Buckets tie, and a due
-- date is a promise to the customer, not a running order.
--
-- work_rank is an explicit hand-ordered queue: 1 is the next job to work,
-- 2 is the one after it, NULL means "not on the list" (those sort below the
-- ranked ones by due date, exactly as the board behaved before this).
--
-- Ranks are rewritten as a contiguous 1..N block by the reorder route
-- (/api/graphics-jobs/rank) — never edited a row at a time — so the numbers
-- stay gapless and two jobs can never share a slot. That route is
-- admin-only and writes with the service role, so the graphics_jobs RLS
-- policies (migration 247, which lets graphics_production UPDATE) need no
-- change: production staff still cannot set a rank from the client, which
-- is the point of an admin-controlled list.

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS work_rank INTEGER,
  ADD COLUMN IF NOT EXISTS work_rank_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS work_rank_set_by UUID REFERENCES profiles(id);

-- Partial index: the board only ever orders by the ranked handful, and the
-- vast majority of rows (every archived job) are NULL.
CREATE INDEX IF NOT EXISTS idx_graphics_jobs_work_rank
  ON graphics_jobs(work_rank)
  WHERE work_rank IS NOT NULL;
