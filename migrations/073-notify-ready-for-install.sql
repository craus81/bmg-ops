-- Migration 072: T1.1 Graphics → Install handoff
--
-- Adds a distinct user preference for "graphics ready, waiting on me to install"
-- notifications, separate from the existing notify_ready (which stays for
-- graphics-team awareness of their own job pipeline).
--
-- Default false so only users who opt in (or are explicitly targeted via
-- job_assignments on the related fleet_checkin) get the new event.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS notify_ready_for_install BOOLEAN DEFAULT false;

COMMENT ON COLUMN notification_preferences.notify_ready_for_install IS
  'Opt-in: notify this user when any graphics job transitions to ready AND the matched vehicle is assigned to them (or they are admin). Distinct from notify_ready, which is production-team awareness.';
