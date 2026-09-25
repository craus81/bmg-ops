-- Each user's own bottom-bar tabs, in order (More → Customize Bottom Bar).
--
-- NULL means "use the role default" (src/lib/nav-tabs.ts). The app re-checks
-- every id against the user's current access, so this column can only narrow
-- or reorder the bar, never grant a page. Users write it on their own row
-- through the existing profiles_update_own policy; it is not one of the
-- privilege columns guarded by migration 233.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nav_tabs TEXT[];
