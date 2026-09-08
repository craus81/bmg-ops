-- R6-1: one film catalog with REAL material cost — including the two
-- consumables the shop actually burns and never billed for: premask and
-- ink. wrap_substrates has been the wrap estimator's private price list;
-- this makes it the single catalog production also prices against, and
-- links each logged material line back to the catalog row so the Graphics
-- Costs rollup stops matching on UPPERCASE(name).
--
-- Ink note (owner question, 2026-09-08): Epson Edge Dashboard exposes no
-- public API, and the printer is on the shop LAN while this app runs on
-- Vercel — so ink is priced the way sign shops actually cost it, as a
-- $/ft² rate per media (cartridge cost / observed coverage, or Epson's
-- published ml/m² for that media+mode). Per-film rate wins; the
-- quote_settings default fills in. NULL stays unknown, never $0.

ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS premask_name TEXT;
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS premask_cost_per_sqft NUMERIC(8,4)
  CHECK (premask_cost_per_sqft IS NULL OR premask_cost_per_sqft >= 0);
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS ink_cost_per_sqft NUMERIC(8,4)
  CHECK (ink_cost_per_sqft IS NULL OR ink_cost_per_sqft >= 0);
-- Roll geometry: what a full roll of this film is, so the R6-2 ledger can
-- seed stock and the roll plan can warn on insufficient footage.
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS roll_width_in NUMERIC(6,2)
  CHECK (roll_width_in IS NULL OR (roll_width_in > 0 AND roll_width_in <= 200));
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS roll_length_ft NUMERIC(8,2)
  CHECK (roll_length_ft IS NULL OR (roll_length_ft > 0 AND roll_length_ft <= 5000));

COMMENT ON COLUMN wrap_substrates.ink_cost_per_sqft IS
  'Ink cost per printed ft² for this media (R6-1). Cartridge cost / observed coverage, or Epson published ml/m² for the media+mode. NULL = falls back to quote_settings.default_ink_cost_per_sqft, then unknown.';
COMMENT ON COLUMN wrap_substrates.premask_cost_per_sqft IS
  'Application-tape cost per ft² (R6-1). NULL = falls back to quote_settings.default_premask_cost_per_sqft, then unknown.';

-- Shop-wide fallback rates, on the same singleton the margin floor and
-- shop labor rate live on.
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS default_ink_cost_per_sqft NUMERIC(8,4)
  CHECK (default_ink_cost_per_sqft IS NULL OR default_ink_cost_per_sqft >= 0);
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS default_premask_cost_per_sqft NUMERIC(8,4)
  CHECK (default_premask_cost_per_sqft IS NULL OR default_premask_cost_per_sqft >= 0);

-- Logged material lines gain a catalog link, the rate they were priced at,
-- and where that rate came from — so a manual override is visible as an
-- override instead of silently blending into the cost book.
ALTER TABLE graphics_job_materials ADD COLUMN IF NOT EXISTS substrate_id UUID REFERENCES wrap_substrates(id) ON DELETE SET NULL;
ALTER TABLE graphics_job_materials ADD COLUMN IF NOT EXISTS rate_per_sqft NUMERIC(8,4);
ALTER TABLE graphics_job_materials ADD COLUMN IF NOT EXISTS cost_source TEXT
  CHECK (cost_source IS NULL OR cost_source IN ('catalog', 'settings_default', 'last_logged', 'manual', 'import'));
CREATE INDEX IF NOT EXISTS idx_graphics_job_materials_substrate
  ON graphics_job_materials(substrate_id) WHERE substrate_id IS NOT NULL;

-- 'ink' joins vinyl/laminate/premask/other as a logged category.
ALTER TABLE graphics_job_materials DROP CONSTRAINT IF EXISTS graphics_job_materials_category_check;
ALTER TABLE graphics_job_materials ADD CONSTRAINT graphics_job_materials_category_check
  CHECK (category IN ('vinyl', 'laminate', 'premask', 'ink', 'other'));

COMMENT ON COLUMN graphics_job_materials.cost_source IS
  'How this line was priced (R6-1): catalog = the film''s own rate, settings_default = the shop fallback, last_logged = the old heuristic price book, manual = a human typed it, import = reconciled from a printer/RIP consumption export.';
