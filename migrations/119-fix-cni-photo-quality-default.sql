-- Fix a schema bug from migration 032: cni_profiles.photo_quality is declared
-- DEFAULT 'good', but its CHECK constraint only allows
-- ('pass', 'conditional', 'fail_trends'). Any INSERT that didn't explicitly
-- set photo_quality used the 'good' default and was rejected by the check —
-- e.g. recording a member's NetSuite vendor id, or provisioning a CNI profile
-- for a user tagged installer in user management.
--
-- Reset the default to a valid value. (No data backfill needed: no row could
-- ever have been stored with the invalid 'good' value.)
ALTER TABLE cni_profiles ALTER COLUMN photo_quality SET DEFAULT 'pass';
