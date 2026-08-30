-- Migration 240: purchase requests — the ordering half of audit item 17
-- ("Parts ordering and receiving — still no software at all: no PO from
-- the readiness card, no purchase request, and no receiving flow").
--
-- A row is one "we need N of this part" ask, raised from the parts-readiness
-- card's short rows (or by hand from the purchasing queue). The queue at
-- /admin/purchasing groups pending rows by vendor; a later phase turns a
-- vendor group into a real NetSuite PO and stamps ordered_po_id here.
--
-- item_number is the normalized form (trim/upper — normalizeItemNumber),
-- the same key parts-readiness and netsuite_vendor_po_lines use.
-- vendor_name is free text (netsuite_parts.vendor is a name, not an id);
-- vendor_netsuite_id gets resolved at PO-creation time.
CREATE TABLE IF NOT EXISTS purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_number TEXT NOT NULL,
  netsuite_item_id TEXT,
  description TEXT,
  quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
  vendor_name TEXT,
  vendor_netsuite_id TEXT,
  source_project_id UUID REFERENCES upfit_projects(id) ON DELETE SET NULL,
  needed_by DATE,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ordered', 'cancelled')),
  ordered_po_id UUID REFERENCES netsuite_vendor_pos(id) ON DELETE SET NULL,
  ordered_at TIMESTAMPTZ,
  ordered_by UUID REFERENCES profiles(id),
  requested_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_purchase_requests_pending
  ON purchase_requests(item_number) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_purchase_requests_project
  ON purchase_requests(source_project_id) WHERE source_project_id IS NOT NULL;

ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;

-- Staff read; ALL writes go through the /api/purchase-requests routes
-- (service role), which own enrichment, dedupe, and notifications — the
-- post-migration-226 convention for workflow tables.
DO $$ BEGIN
  CREATE POLICY "staff_read_purchase_requests" ON purchase_requests
    FOR SELECT TO authenticated USING (public.is_internal_staff());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
