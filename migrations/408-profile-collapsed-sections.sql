-- Sections each user has folded shut on record pages (Craig, 2026-10-19:
-- "a way to collapse ... so we don't have to scroll so much ... the
-- expand/collapse state should save for future viewings").
--
-- One key per collapsed section, '<page>:<section>' (e.g. 'customer:contacts').
-- NULL or absent = open, so a new section starts open for everyone. Saved on
-- the profile, like nav_tabs (migration 325), so the choice follows the user
-- from the iPhone app to the desktop. Written through the existing
-- profiles_update_own policy; not a privilege column (migration 233).

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS collapsed_sections TEXT[];
