-- Each user's own side-bar tabs for the OPEN iPhone Duo screen, in order
-- (More → Customize Bottom Bar → Open screen).
--
-- NULL means "your bottom bar, then your other pages" (src/lib/nav-tabs.ts).
-- Like nav_tabs (migration 325) every id is re-checked against the user's
-- current access, so this can only narrow or reorder, never grant a page.
-- Written through the existing profiles_update_own policy.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS nav_tabs_open TEXT[];
