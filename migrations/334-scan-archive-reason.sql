-- Migration 334: archive a scan without invoicing it, with an optional reason.
--
-- The Scan Log could only archive scans from the Exported tab, and nothing
-- recorded why a scan left the billing queue or who took it out. Scans can
-- now be archived from Ready to Export, Waiting for PO and All Scans too
-- (POST /api/scans/archive), and the Archived tab shows "Not billed" with the
-- reason and who archived it.
--
-- archive_reason: optional free text (the page offers presets such as
--   Warranty/redo, Duplicate, No charge, Billed elsewhere). NULL for scans
--   archived by invoicing or before this migration.
-- archived_by: who archived it. Unarchive clears both.

ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
