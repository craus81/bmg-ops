-- Fleet multi-unit quoting (R6-9): one line set, N identical vehicles.
--
-- Quoting twelve identical vans meant building twelve copies of the same
-- line set, or quoting one and multiplying in your head before typing the
-- total somewhere. Neither survives a revision.
--
-- The count multiplies LINE QUANTITIES, not the finished totals. Multiplying
-- totals would break the penny-for-penny tax parity src/lib/estimate-totals.ts
-- exists to hold: tax is computed per line, rounded to cents, then summed —
-- the way NetSuite books it — and round(lineTax) × N is not round(lineTax × N).
-- Multiplying quantities is also exactly what the sales order carries, so the
-- pushed copy needs no second interpretation of what the count meant.
--
-- DEFAULT 1 with a >= 1 check: every existing estimate keeps byte-identical
-- totals, and there is no such thing as a zero-vehicle quote.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS vehicle_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE estimates DROP CONSTRAINT IF EXISTS estimates_vehicle_count_check;
ALTER TABLE estimates ADD CONSTRAINT estimates_vehicle_count_check CHECK (vehicle_count >= 1);

COMMENT ON COLUMN estimates.vehicle_count IS
  'How many identical vehicles this line set covers (R6-9). Multiplies every line quantity and the labor hours; 1 = an ordinary single-vehicle estimate. labor_hours and labor_hours_override remain JOB totals, not per-vehicle figures.';
