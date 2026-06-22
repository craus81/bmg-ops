-- Fix a schema bug from migration 032: cni_profiles.photo_quality is declared
-- DEFAULT 'good', but its CHECK constraint only allows
-- ('pass', 'conditional', 'fail_trends'). Any INSERT that didn't explicitly
-- set photo_quality used the 'good' default and was rejected by the check —
-- e.g. recording a member's NetSuite vendor id, the invite flow's stub
-- profile (which failed silently, so invited installers never appeared in the
-- CNI installers list), and installer onboarding.
--
-- Reset the default to a valid value. (No data backfill of photo_quality is
-- needed: no row could ever have been stored with the invalid 'good' value.)
ALTER TABLE cni_profiles ALTER COLUMN photo_quality SET DEFAULT 'pass';

-- Retroactive reconciliation: every user tagged as an installer in user
-- management should have a cni_profiles record. Because the stub insert above
-- had been failing, existing installers are likely missing their row, which
-- left them invisible on the CNI installers list / dashboard count and made
-- their detail page error out. Create a minimal profile for anyone missing
-- one, carrying their assigned company's name. Idempotent — safe to re-run.
INSERT INTO cni_profiles (user_id, company_name, photo_quality, profile_complete)
SELECT p.id, c.name, 'pass', FALSE
FROM profiles p
LEFT JOIN companies c ON c.id = p.company_id
WHERE (p.role = 'installer' OR 'installer' = ANY(p.roles))
  AND NOT EXISTS (
    SELECT 1 FROM cni_profiles cp WHERE cp.user_id = p.id
  );
