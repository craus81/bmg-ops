-- R5-7: Owner's Weekly Brief opt-out.
-- The Monday brief cron targets approved super_admin/executive accounts only;
-- this column lets one of them turn it off (opt-out, default on). Lives on
-- notification_preferences like every other toggle — profiles self-updates
-- are guarded by the migration-233 trigger.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS notify_weekly_brief BOOLEAN DEFAULT true;

COMMENT ON COLUMN notification_preferences.notify_weekly_brief IS
  'Monday owner''s brief (email + in-app). Opt-out, default true; only super_admin/executive accounts are ever targeted.';
