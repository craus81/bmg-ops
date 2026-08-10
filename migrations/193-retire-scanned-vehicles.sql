-- Migration 193: retire the legacy scanned_vehicles table
-- (docs/cni-redesign.md §1.4, Phase 0 — confirmed with Craig 2026-08-10:
-- the photo-review queue is dead and no old /view share links are in use)
--
-- scanned_vehicles was the first-generation scan system. Migration 068
-- copied its scan history into scan_logs (the declared single source of
-- truth) and nothing has inserted a row since — every remaining code
-- reference was a frozen-queue count, an unreachable legacy page, or FK
-- plumbing, all removed in this deploy.
--
-- RENAME, not DROP: the era's photo-review states and old share ids were
-- never copied anywhere (068 took scan history only), so the table sticks
-- around as a queryable archive under a name no code path can hit. An
-- actual DROP can be a one-liner later once nobody has missed it.
--
-- po_line_item_id IS dropped: renaming keeps foreign keys live, and the
-- retired rows' FK to po_line_items would otherwise keep blocking PO
-- line-item deletes forever (the app-side FK-clearing code is removed in
-- this deploy). The linkage itself was already carried into scan_logs by
-- migration 068.

ALTER TABLE scanned_vehicles DROP COLUMN IF EXISTS po_line_item_id;

ALTER TABLE scanned_vehicles RENAME TO scanned_vehicles_retired;

COMMENT ON TABLE scanned_vehicles_retired IS
  'First-generation scan tracking, retired 2026-08 (cni-redesign Phase 0). Scan history was copied to scan_logs by migration 068; this archive keeps the old photo-review states. No code reads or writes it. Safe to drop once nobody has missed it.';
