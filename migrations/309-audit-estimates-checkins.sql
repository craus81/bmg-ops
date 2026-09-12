-- Migration 309: field-level history for estimates and vehicle check-ins
-- (R6-13).
--
-- The History control lands on five record types, but the row-diff trigger
-- from migration 195 only ever covered three (upfit_projects,
-- graphics_jobs, cni_jobs). On an estimate the audit log holds nothing but
-- a handful of hand-written logAudit actions, and on a check-in it holds
-- nothing at all — so two of those five buttons would open an empty page
-- and read as "nobody ever changed this", which is the opposite of what a
-- history control is for.
--
-- Both tables are re-used verbatim from 195's function; only the
-- ignore-lists differ, and each entry is a column a cron or sync churns
-- rather than a person changing something:
--
--   estimates      — approval/reminder/delivery stamps written by the
--                    quote-followup cron, the Resend webhook, and the
--                    view recorder. Without these, every nightly sweep
--                    would write an audit row on every open estimate.
--   fleet_checkins — the same idea for arrival and sync churn.
--
-- Money and commitment columns (totals, status, approval, vehicle_count,
-- promised-back) are deliberately NOT ignored: those are exactly what the
-- history is being asked for.

DROP TRIGGER IF EXISTS trg_audit_estimates ON estimates;
CREATE TRIGGER trg_audit_estimates
  AFTER UPDATE OR DELETE ON estimates
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff(
    'updated_at', 'updated_by',
    'approval_reminder_sent_at',    -- quote-followup cron churn
    'approval_reminder_count',
    'approval_relink_at',           -- migration 305
    'approval_relink_count',
    'approval_email_id',            -- Resend webhook delivery churn
    'approval_email_status',
    'approval_email_detail',
    'approval_email_updated_at',
    'expiry_warned_for',            -- migration 301 sweep stamps
    'expiry_notified_for',
    'never_opened_notified_at',     -- migration 302 sweep stamp
    'last_followup_at',
    'followup_nudged_at'
  );

DROP TRIGGER IF EXISTS trg_audit_fleet_checkins ON fleet_checkins;
CREATE TRIGGER trg_audit_fleet_checkins
  AFTER UPDATE OR DELETE ON fleet_checkins
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff(
    'updated_at', 'updated_by'
  );
