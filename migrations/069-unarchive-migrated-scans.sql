-- Migration 069: Fix migrated scans that were incorrectly archived
-- Migration 068 set archived_at on exported records, hiding them from view.
-- Clear archived_at so they appear in the Exported tab of the Scan Log.

UPDATE scan_logs
SET archived_at = NULL
WHERE archived_at IS NOT NULL
AND archived_at = exported_at;
