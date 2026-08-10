-- Migration 187: Customer segmentation tags + billing workflow (K2/K3 —
-- Aug 6 session plan, docs/fleetsuite-plan-2026-08-06.md).
--
-- K2: industry/partner tags behind a CONTROLLED vocabulary — free-text
-- chips (the prospect_tags pattern) defeat segmentation, so the audit
-- writes tag rows that reference a small admin-editable vocabulary table.
--
-- K3: per-customer billing workflow so invoice surfaces can route
-- correctly instead of relying on tribal knowledge ("Bogle portal" appears
-- nowhere in the repo today). Taxonomy per the Aug 6 decision:
--   * po_portal     — we submit invoices in the customer's portal
--                     (Masterack, Bogle, ...). Email surfaces show a
--                     "don't email" banner; billing_portal names it.
--   * email_ap      — invoices are emailed to the customer's AP addresses.
--   * no_po_direct  — customer is invoiced directly, no PO required
--                     (pairs with the Scan Log NO_PO path).
--
-- All customers columns here are FleetSuite-owned (migration-080 pattern):
-- the NetSuite sync upserts only NS-sourced fields, so nothing below is
-- clobbered on resync.

-- ═══════════ customers — billing workflow (K3) ═══════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS billing_workflow TEXT
    CHECK (billing_workflow IN ('po_portal', 'email_ap', 'no_po_direct')),
  ADD COLUMN IF NOT EXISTS billing_portal TEXT,
  ADD COLUMN IF NOT EXISTS billing_notes TEXT;

COMMENT ON COLUMN customers.billing_workflow IS 'FleetSuite-owned. How this customer is billed: po_portal (submit in their portal — don''t email), email_ap (email AP), no_po_direct (direct invoice, no PO).';
COMMENT ON COLUMN customers.billing_portal IS 'FleetSuite-owned. Portal name for po_portal customers (e.g. Masterack, Bogle).';
COMMENT ON COLUMN customers.billing_notes IS 'FleetSuite-owned. Free-form billing instructions (portal URL, required fields, cadence).';

-- ═══════════ customer_tag_vocabulary — controlled values (K2) ═══════════
CREATE TABLE IF NOT EXISTS customer_tag_vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label TEXT NOT NULL UNIQUE,
  -- 'industry' (what the customer does) vs 'partner' (their relationship
  -- to BMG). Both render as chips; the split keeps filters meaningful.
  kind TEXT NOT NULL DEFAULT 'industry' CHECK (kind IN ('industry', 'partner')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ═══════════ customer_tags — assignments ═══════════
CREATE TABLE IF NOT EXISTS customer_tags (
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES customer_tag_vocabulary(id) ON DELETE CASCADE,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (customer_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_tags_tag ON customer_tags(tag_id);

ALTER TABLE customer_tag_vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_tags ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage tag vocabulary' AND tablename = 'customer_tag_vocabulary') THEN
    CREATE POLICY "Internal staff can manage tag vocabulary" ON customer_tag_vocabulary
      FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff can manage customer tags' AND tablename = 'customer_tags') THEN
    CREATE POLICY "Internal staff can manage customer tags" ON customer_tags
      FOR ALL TO authenticated
      USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
  END IF;
END $$;

-- ═══════════ starter vocabulary ═══════════
-- Editable in-app (add/rename/deactivate); this is just the seed so
-- Ashley's profile audit starts from consistent values instead of a blank
-- list. ON CONFLICT keeps the migration idempotent and preserves edits.
INSERT INTO customer_tag_vocabulary (label, kind) VALUES
  ('Pest Control',           'industry'),
  ('HVAC / Plumbing',        'industry'),
  ('Electrical',             'industry'),
  ('Telecom / Fiber',        'industry'),
  ('Construction',           'industry'),
  ('Landscaping / Outdoor',  'industry'),
  ('Delivery / Logistics',   'industry'),
  ('Government / Municipal', 'industry'),
  ('Healthcare / Medical',   'industry'),
  ('Food & Beverage',        'industry'),
  ('Property Services',      'industry'),
  ('Security',               'industry'),
  ('Leasing / FMC',          'partner'),
  ('Upfitter Partner',       'partner'),
  ('OEM / Dealer',           'partner'),
  ('Graphics Partner',       'partner')
ON CONFLICT (label) DO NOTHING;
