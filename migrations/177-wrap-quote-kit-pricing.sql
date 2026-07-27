-- Kit quantity + job-level price adjustments for wrap quotes.
--
-- The estimator's drawn canvas prices ONE kit (one vehicle's graphics
-- package). package_qty multiplies the sqft-driven parts of the quote
-- (materials and per-film install labor) for "12 of this package" jobs;
-- the design/preparation/installation labor sections stay one-time.
--
-- adjustments is a display snapshot of how the final numbers were reached:
--   { package_qty, kit_area_sqft, kit_materials,
--     pre_materials, pre_labor, pre_subtotal,
--     discount_pct, discount_amount, min_charge, min_bump }
-- The stored materials_total / labor_total have the discount and shop
-- minimum folded in proportionally, so the NetSuite estimate push and the
-- graphics-invoice derivation (which read those two columns directly) always
-- sum to exactly what the customer was quoted. NULL = plain single-kit quote
-- with no adjustments (all pre-existing rows).
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS package_qty INTEGER NOT NULL DEFAULT 1;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS adjustments JSONB;

-- Job-pricing policy on the settings singleton:
--   min_job_charge — no job quotes below this pre-tax floor; small jobs get
--     a visible "shop minimum" bump (a 3 ft² decal at $45 doesn't cover the
--     time the job takes end to end).
--   qty_discounts — tiers [{"min_qty": 12, "pct": 10}, ...]; the highest pct
--     whose min_qty the kit count reaches is applied automatically (the
--     estimator can override the percentage per quote).
ALTER TABLE wrap_quote_settings ADD COLUMN IF NOT EXISTS min_job_charge NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE wrap_quote_settings ADD COLUMN IF NOT EXISTS qty_discounts JSONB NOT NULL DEFAULT '[]'::jsonb;
