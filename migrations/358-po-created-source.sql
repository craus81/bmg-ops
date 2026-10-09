-- Migration 358: say "Imported from email" on customer POs that came in
-- through the Gmail PO import, and stop crediting them to an admin who
-- never touched them (owner report 2026-10-09: PO #35052221 showed
-- "Created by Valarie Fleahman", who has never imported a PO).
--
-- Until 2026-10-08 the import stamped created_by with whichever admin the
-- profiles query returned first, not the person who confirmed the import,
-- so the "Created by" tag put that admin's name on every email-imported PO.
-- Since PR #1098 the import records the real person.
--
-- created_source:
--   NULL                  made by hand in FleetSuite (created_by is the person)
--   'email'               Gmail import; created_by is the person who confirmed it
--   'email_unattributed'  Gmail import with no known importer; created_by is
--                         only a placeholder admin and must not be shown
--
-- created_by is left as is (the table predates migrations and may require
-- it); the tag reads created_source to decide whether to show the name.
--
-- Backfill: a PO is email-made when an imported gmail_po_imports row points
-- at it. Those created before the fix are unattributed when their creator
-- is an admin (the placeholder); a non-admin creator was a real person who
-- made the PO by hand before an email later updated it, so it keeps NULL.

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS created_source TEXT;

COMMENT ON COLUMN purchase_orders.created_source IS
  'How the PO was created: NULL = by hand; ''email'' = Gmail import confirmed by created_by; ''email_unattributed'' = Gmail import, importer unknown (created_by is a placeholder admin).';

UPDATE purchase_orders po
SET created_source = 'email_unattributed'
WHERE po.created_source IS NULL
  AND po.created_at < '2026-10-08T02:03:00Z'
  AND EXISTS (
    SELECT 1 FROM gmail_po_imports g
    WHERE g.po_id = po.id AND g.status = 'imported'
  )
  AND (
    po.created_by IS NULL
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = po.created_by AND p.role IN ('admin', 'super_admin')
    )
  );

-- Imports between PR #1098 and this migration recorded the real person.
UPDATE purchase_orders po
SET created_source = 'email'
WHERE po.created_source IS NULL
  AND po.created_at >= '2026-10-08T02:03:00Z'
  AND EXISTS (
    SELECT 1 FROM gmail_po_imports g
    WHERE g.po_id = po.id AND g.status = 'imported'
  );
