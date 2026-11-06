-- Migration 522: What's new in FleetSuite.
--
-- Craig, 2026-11-06: "a daily new features and bug fixes with a release
-- number so people can see what's new". The notes themselves ship with the
-- code (src/lib/release-notes.json); this only remembers, per person, the
-- newest release they've seen, so the one-time popup, the dashboard banner
-- and the dot on More each go away once handled:
--
--   { "page": "2026.11.06", "popup": "2026.11.06", "banner": "2026.11.05" }
--
-- NULL = nothing seen yet. Saved on the profile, like collapsed_sections
-- (migration 408), so it follows the person from the iPhone app to the
-- desktop. Written through the existing profiles_update_own policy; not a
-- privilege column (migration 233).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS whats_new_seen JSONB;

COMMENT ON COLUMN profiles.whats_new_seen IS
  'Newest What''s new release this person has seen on the page, its popup and its dashboard banner (migration 522). See src/lib/release-notes.ts.';
