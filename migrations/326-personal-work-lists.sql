-- Per-person priority lists ("My List") for graphics jobs and In-Shop vehicles.
--
-- The shared graphics work order (migration 318) answers "what does the shop
-- do next"; it can't give two people on the same job different answers. Here
-- a manager orders each person's own assigned jobs, and that person sees them
-- in that order (owner decisions, 2026-09-25):
--   - admins set the order; people only read their own list
--   - graphics and vehicles are separate lists (list_type), each on its board
--   - a job with several assignees sits on each of their lists, at its own spot
--
-- Membership is NOT stored here: a person's list is whatever is assigned to
-- them right now (job_assignments + the job's assigned_to mirror), computed
-- by /api/work-lists. This table only holds the order. A row whose job was
-- unassigned or finished is simply ignored and cleared on the next save, and
-- assigned jobs with no row yet sort below the ordered ones in the board's
-- default order.
--
-- Writes go through /api/work-lists (admin-only, service role), which
-- rewrites one person's list as a contiguous 1..N block, so there are no
-- client write policies.

CREATE TABLE IF NOT EXISTS personal_work_ranks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  list_type TEXT NOT NULL CHECK (list_type IN ('graphics', 'vehicle')),
  job_id UUID NOT NULL,
  rank INTEGER NOT NULL,
  set_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, list_type, job_id)
);

CREATE INDEX IF NOT EXISTS idx_personal_work_ranks_user
  ON personal_work_ranks(user_id, list_type, rank);

ALTER TABLE personal_work_ranks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS personal_work_ranks_read ON personal_work_ranks;
CREATE POLICY personal_work_ranks_read ON personal_work_ranks
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.get_my_roles() && ARRAY['admin', 'super_admin']);
