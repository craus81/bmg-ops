-- R6-7 part 3: catalog auto-enrichment proposals.
--
-- The enrichment pass NEVER writes netsuite_parts directly. It writes
-- proposals here, an admin accepts or rejects each one, and only the accept
-- touches the catalog. Two reasons this matters more than the usual
-- review-queue instinct:
--   1. product_category_id carries category_source = 'manual' the moment a
--      human sets it, and that flag permanently excludes the part from the
--      rule sweep (migration 209). A model writing straight through would
--      silently freeze thousands of parts out of rule-based tagging.
--   2. A wrong browse category is invisible until a salesperson can't find
--      a part they know exists. Nobody audits a catalog.
--
-- Vendor backfill from purchase history is deterministic (who we last
-- actually bought it from), so it lands as a proposal too — with its
-- evidence — but it is the one field where the source is a fact rather
-- than a judgement, and the UI says so.

CREATE TABLE IF NOT EXISTS part_enrichment_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id UUID NOT NULL REFERENCES netsuite_parts(id) ON DELETE CASCADE,
  -- Denormalized so a rejected proposal still reads sensibly after the
  -- part is merged away (parts merge, migration 232).
  item_number TEXT NOT NULL,

  field TEXT NOT NULL CHECK (field IN (
    'product_category_id', 'vehicle_type', 'graphic_package',
    'marketing_description', 'vendor', 'catalog', 'misfile'
  )),
  -- Always TEXT: a uuid category id, a free-text vehicle type, or, for
  -- 'misfile', the short reason. The accept path casts per field.
  proposed_value TEXT,
  -- What to SHOW for proposed_value when the raw value is an id.
  proposed_label TEXT,
  -- What the field holds today, captured when the proposal was made, so a
  -- reviewer sees the change and a stale proposal can be detected.
  current_value TEXT,

  confidence TEXT NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('high', 'medium', 'low')),
  -- WHICH signal produced this — never a bare assertion. e.g.
  -- "description says 'ladder rack'", "8 of the last 10 POs: Adrian Steel".
  evidence TEXT,
  source TEXT NOT NULL DEFAULT 'model'
    CHECK (source IN ('model', 'purchase_history')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  decided_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  -- Groups one pass's output so a bad run can be rejected wholesale.
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE part_enrichment_proposals IS
  'Proposed catalog enrichments awaiting human review (R6-7). Accepting one writes netsuite_parts; nothing here touches the catalog on its own.';

-- One live proposal per part+field: a re-run refreshes the pending row
-- instead of stacking a second opinion on the same gap.
CREATE UNIQUE INDEX IF NOT EXISTS idx_part_enrich_pending_unique
  ON part_enrichment_proposals(part_id, field) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_part_enrich_status
  ON part_enrichment_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_part_enrich_run
  ON part_enrichment_proposals(run_id) WHERE run_id IS NOT NULL;

ALTER TABLE part_enrichment_proposals ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Staff read enrichment proposals'
      AND tablename = 'part_enrichment_proposals'
  ) THEN
    CREATE POLICY "Staff read enrichment proposals" ON part_enrichment_proposals
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
