-- Migration 297: invite & bid SLA engine (R6-8)
--
-- An invite that nobody answers is the quiet failure mode of the CNI
-- pipeline: the coordinator assumes it is being considered, the installer
-- never opened the portal, and the job sits until someone notices the
-- deadline. The SLA engine ages every invite against a clock and re-pings
-- once — which needs exactly two stamps.
--
-- Both are "has this already happened", not state: they exist so the daily
-- sweep nags ONCE rather than every morning.

-- One automatic re-ping per invite, ever. A coordinator can still re-invite
-- by hand as often as they like; that path is deliberate, this one is not.
ALTER TABLE cni_job_invites ADD COLUMN IF NOT EXISTS repinged_at TIMESTAMPTZ;

COMMENT ON COLUMN cni_job_invites.repinged_at IS
  'Migration 297: set when the daily CNI sweep automatically re-pinged an unanswered invite past the SLA. Set once — a second automatic nudge on the same invite is noise, and a human re-invite does not touch this.';

-- One "this job has no takers" alert per job, ever. Re-alerting daily on a
-- job the coordinator has already seen and decided to wait on is how the
-- alert gets ignored.
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS invite_sla_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN cni_jobs.invite_sla_alerted_at IS
  'Migration 297: set when the daily CNI sweep told the coordinator this job was past its invite SLA with nobody accepting. Set once; cleared by the app when the job is assigned, so a job that goes back out to bid can alert again.';

-- The sweep reads unanswered invites by age.
CREATE INDEX IF NOT EXISTS idx_cni_job_invites_sent
  ON cni_job_invites(sent_at DESC);
