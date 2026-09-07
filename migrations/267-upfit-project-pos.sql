-- Migration 267: upfit_project_pos — a project's vendor POs, ALL of them.
--
-- upfit_projects has carried exactly one PO since 075
-- (netsuite_vendor_po_id/_number), and create-po deliberately stamps only
-- the FIRST PO ("first PO wins"). A second wave of parts, or a split
-- across two vendors, left PO #2 invisible on the project: the page shows
-- one number, parts-email-scan tracks one PO's ETA, and a PO cut directly
-- in NetSuite (no purchase_requests rows) can't be linked at all. The
-- request join (purchase_requests.ordered_po_id) papered over the
-- notification/margin gaps for queue-born POs; this table is the real
-- link — one row per (project, PO), any number of POs per project.
--
-- Two id spaces, deliberately: the scalar netsuite_vendor_po_id holds the
-- NetSuite INTERNAL id (text), while this table references the mirror row
-- (netsuite_vendor_pos.id UUID) — same choice as
-- purchase_requests.ordered_po_id. The sync never deletes mirror headers
-- (it only replaces lines), so the CASCADE is a formality. po_number is a
-- write-time snapshot for notes/logs; live display joins the mirror.
--
-- The scalar columns STAY and keep their first-PO stamp — ~10 legacy
-- readers depend on them. Same pattern as fleet_checkin_sales_orders
-- (100) and fleet_checkin_invoices (261): scalar grows a join table,
-- legacy column kept for compatibility.

CREATE TABLE IF NOT EXISTS upfit_project_pos (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES upfit_projects(id) ON DELETE CASCADE,
  po_id UUID NOT NULL REFERENCES netsuite_vendor_pos(id) ON DELETE CASCADE,
  po_number TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('request_queue', 'manual', 'backfill')),
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, po_id)
);

CREATE INDEX IF NOT EXISTS idx_upfit_project_pos_project ON upfit_project_pos(project_id);
CREATE INDEX IF NOT EXISTS idx_upfit_project_pos_po ON upfit_project_pos(po_id);

-- Staff read; writes go through create-po and /api/upfit-projects/link-po
-- on the service role, so link provenance (source, created_by) is always
-- stamped and the project timeline gets its note.
ALTER TABLE upfit_project_pos ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Staff read project PO links' AND tablename = 'upfit_project_pos') THEN
    CREATE POLICY "Staff read project PO links" ON upfit_project_pos
      FOR SELECT TO authenticated USING (public.is_internal_staff());
  END IF;
END $$;

-- Backfill: seed from everything the system already knows, so day one the
-- table holds the full picture. Idempotent — every insert is
-- ON CONFLICT DO NOTHING against the (project_id, po_id) pair.

-- a. The request join: every ordered purchase request that names both its
--    project and its PO mirror row.
INSERT INTO upfit_project_pos (project_id, po_id, po_number, source)
SELECT DISTINCT pr.source_project_id, pr.ordered_po_id, po.tranid, 'backfill'
FROM purchase_requests pr
JOIN netsuite_vendor_pos po ON po.id = pr.ordered_po_id
WHERE pr.source_project_id IS NOT NULL
  AND pr.ordered_po_id IS NOT NULL
ON CONFLICT (project_id, po_id) DO NOTHING;

-- b. The scalar first-PO columns, resolved to mirror rows both ways the
--    margin report does: by NetSuite internal id, then by PO number.
INSERT INTO upfit_project_pos (project_id, po_id, po_number, source)
SELECT p.id, po.id, po.tranid, 'backfill'
FROM upfit_projects p
JOIN netsuite_vendor_pos po ON po.netsuite_id = p.netsuite_vendor_po_id
WHERE p.netsuite_vendor_po_id IS NOT NULL
ON CONFLICT (project_id, po_id) DO NOTHING;

INSERT INTO upfit_project_pos (project_id, po_id, po_number, source)
SELECT p.id, po.id, po.tranid, 'backfill'
FROM upfit_projects p
JOIN netsuite_vendor_pos po ON po.tranid = p.netsuite_vendor_po_number
WHERE p.netsuite_vendor_po_number IS NOT NULL
ON CONFLICT (project_id, po_id) DO NOTHING;

COMMENT ON TABLE upfit_project_pos IS
  'Migration 267: every vendor PO linked to an upfit project (the single netsuite_vendor_po_id/_number columns hold only the FIRST). po_id references the netsuite_vendor_pos mirror row. Written by create-po (source request_queue) and /api/upfit-projects/link-po (source manual); seeded by backfill.';
