-- Fleet orders: the same build on several vehicles (Craig, 2026-10-19).
-- Each vehicle keeps its own estimate, because each becomes its own sales
-- order and shop work order, but the estimates belong together: one
-- graphics job makes a kit per unit number, and the customer approves one
-- proof for all of them.
--
-- fleet_group_id is shared by every estimate in the order. "Copy for more
-- vehicles" (/api/estimates/[id]/fleet-copies) sets it on the source and
-- its copies. NULL = not part of a fleet order. No table of its own: the
-- group is just the estimates that share the id.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS fleet_group_id UUID;

CREATE INDEX IF NOT EXISTS estimates_fleet_group_id_idx
  ON estimates (fleet_group_id)
  WHERE fleet_group_id IS NOT NULL;

COMMENT ON COLUMN estimates.fleet_group_id IS
  'Fleet order this estimate belongs to (one estimate per vehicle, same build). Shared by every estimate in the order; NULL = not in one.';
