-- Estimator refinements: films can be paired with an overlaminate that
-- prices as one combined material (e.g. IJ280 print film + 8428 laminate),
-- and each film carries a display color so the estimator can draw its
-- measurement boxes in distinct colors when a vehicle mixes films.
-- ("Film" is the correct term for the material; a substrate is the surface
-- being wrapped. The table keeps its historical name to avoid churn.)
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS laminate_name TEXT;
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS laminate_price_per_sqft NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS color TEXT;

-- Default install-labor rate per film ($/sqft). The Generate Quote screen
-- prefills from this and allows a per-quote override; labor is computed from
-- each film's total measured square footage.
ALTER TABLE wrap_substrates ADD COLUMN IF NOT EXISTS labor_per_sqft NUMERIC NOT NULL DEFAULT 0;
