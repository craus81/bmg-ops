-- Migration 209: part category tagging rules
--
-- Craig 2026-08-18: "Can I create tagging rules for parts? Like all parts
-- from Legend Fleet that have 'liner' in the name should be categorized as
-- Wall Liners." Migration 197 gave every part ONE browse category, but the
-- only way to set it is the per-card dropdown in the catalog browser — one
-- click per part, and every resync brings new parts in uncategorized.
--
-- A rule is (vendor scope, text match, target category, priority). The
-- sweep in src/lib/part-category-rules.ts evaluates rules in priority
-- order, first match wins, and writes the winner onto the part.
--
-- Manual always wins. netsuite_parts.category_source records who set the
-- category: 'manual' (a human, via the browser dropdown) is never touched
-- by the sweep, 'rule' is recomputed on every run. A human CLEARING a
-- category also stamps 'manual' — "no, this part has no category" is an
-- answer, and the next sweep must not undo it.
--
-- Both columns are FleetSuite-owned (migration-080 pattern): the NetSuite
-- parts sync never writes them.

CREATE TABLE IF NOT EXISTS part_category_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Optional label; the rule reads fine without one ("Legend Fleet · liner
  -- → Wall Liners"), so this is a nicety, not a key.
  name TEXT,
  -- Vendor scope: case-insensitive substring of netsuite_parts.vendor.
  -- NULL = every vendor. (Substring, not equality, matches the
  -- vendor_import_profiles.vendor_scope semantics staff already know.)
  vendor TEXT,
  -- How `pattern` is matched against the fields in match_fields:
  --   contains — case-insensitive substring ("liner" hits "Headliner")
  --   word     — case-insensitive whole word ("liner" does NOT hit "Headliner")
  --   regex    — case-insensitive JS regex, validated on save
  match_type TEXT NOT NULL DEFAULT 'contains'
    CHECK (match_type IN ('contains', 'word', 'regex')),
  pattern TEXT NOT NULL CHECK (length(btrim(pattern)) > 0),
  -- Which part text the pattern is matched against.
  match_fields TEXT[] NOT NULL DEFAULT ARRAY['item_number', 'display_name'],
  category_id UUID NOT NULL REFERENCES product_categories(id) ON DELETE CASCADE,
  -- Lower runs first; ties broken by created_at. First match wins, so a
  -- narrow rule needs a lower priority than the broad one it refines.
  priority INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  -- Parts this rule owned as of the last apply (not dry runs).
  last_matched_count INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_part_category_rules_order
  ON part_category_rules(priority, created_at) WHERE active;

COMMENT ON TABLE part_category_rules IS
  'Auto-categorization rules for the catalog browser: vendor scope + text match -> product_categories. Evaluated in priority order, first match wins; never overrides a human assignment (netsuite_parts.category_source = manual).';

ALTER TABLE netsuite_parts
  ADD COLUMN IF NOT EXISTS category_source TEXT
    CHECK (category_source IN ('manual', 'rule')),
  ADD COLUMN IF NOT EXISTS category_rule_id UUID
    REFERENCES part_category_rules(id) ON DELETE SET NULL;

COMMENT ON COLUMN netsuite_parts.category_source IS
  'Who set product_category_id: manual (human — never overwritten by the rule sweep, including a deliberate clear to NULL) or rule. FleetSuite-owned.';
COMMENT ON COLUMN netsuite_parts.category_rule_id IS
  'The part_category_rules row that set product_category_id (only when category_source = rule). FleetSuite-owned.';

CREATE INDEX IF NOT EXISTS idx_netsuite_parts_category_rule
  ON netsuite_parts(category_rule_id) WHERE category_rule_id IS NOT NULL;

-- Everything categorized before this migration was set by hand in the
-- catalog browser (the per-card dropdown was the only writer), so protect
-- it from the first sweep.
UPDATE netsuite_parts
  SET category_source = 'manual'
  WHERE product_category_id IS NOT NULL AND category_source IS NULL;

-- Admin-only feature behind service-role API routes
-- (/api/parts/category-rules, requireAdmin) — RLS on, no policies, so
-- clients can't read or write the table directly.
ALTER TABLE part_category_rules ENABLE ROW LEVEL SECURITY;
