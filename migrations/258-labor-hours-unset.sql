-- Labor hours: "0" means we don't charge labor; blank means not set yet.
--
-- netsuite_parts.labor_hours defaulted to 0 and the NetSuite sync wrote 0
-- for a blank custitem1, so a part nobody had priced labor for and a part
-- deliberately priced at no labor were indistinguishable — and an estimate
-- built from an unpriced part silently quoted zero labor. Owner decision
-- (2026-09-03): NULL = not set (rendered as a dash, flagged on estimate
-- lines), 0 = no labor charged (rendered as 0h).
--
-- Backfill: every existing 0 becomes NULL. The sync stamped 0 on every
-- part NetSuite left blank, so 0 was never a deliberate entry; parts that
-- genuinely carry no labor get set to 0 by hand from here on.

ALTER TABLE netsuite_parts ALTER COLUMN labor_hours DROP DEFAULT;
UPDATE netsuite_parts SET labor_hours = NULL WHERE labor_hours = 0;

COMMENT ON COLUMN netsuite_parts.labor_hours IS
  'Install labor hours per unit. NULL = not set yet (dash in the UI, flagged on estimate lines); 0 = deliberately no labor charged. The NetSuite sync writes it only when custitem1 carries a value, so FleetSuite entries survive.';

-- Estimate lines carry the same distinction from the part they were built
-- from. Existing lines are left alone — a saved quote's zero was what the
-- customer saw.
ALTER TABLE estimate_line_items ALTER COLUMN labor_hours DROP DEFAULT;

COMMENT ON COLUMN estimate_line_items.labor_hours IS
  'Labor hours per unit copied from the part when the line was added. NULL = the part had no labor set (the builder flags it); 0 = no labor.';
