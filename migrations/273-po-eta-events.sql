-- 273: Append-only vendor ETA history (R5-2, Tier 2 vendor-scorecards item —
-- the capture half, shipped first and separately: eta_date is overwritten in
-- place, so "Ranger said the 12th, delivered the 21st" was unprovable a week
-- later and promised-vs-actual can only start accruing from this deploy.
--
-- One row per ETA landing or change. Written today by the single ETA
-- chokepoint (applyEmailToPo in src/lib/parts-email-scan.ts — the email
-- scan and the manual parts-mail link both funnel through it). Any future
-- manual ETA editor MUST also insert here or the promise record goes
-- email-only. The vendor scorecard (R5-11) reads first-ETA vs final
-- receipt, slip counts, and slip magnitude from these rows.
CREATE TABLE IF NOT EXISTS po_eta_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES netsuite_vendor_pos(id) ON DELETE CASCADE,
  po_tranid TEXT,
  vendor_name TEXT,
  eta_date DATE NOT NULL,
  previous_eta DATE,            -- what it replaced; NULL = the PO's first ETA
  source TEXT NOT NULL,         -- 'email' today; 'manual' when an editor exists
  detail TEXT,                  -- e.g. the mailbox/subject label the scan attributes
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_po_eta_events_po ON po_eta_events(po_id, created_at);
CREATE INDEX IF NOT EXISTS idx_po_eta_events_vendor ON po_eta_events(vendor_name, created_at);
ALTER TABLE po_eta_events ENABLE ROW LEVEL SECURITY;
-- No policies: service-role writes/reads only.
