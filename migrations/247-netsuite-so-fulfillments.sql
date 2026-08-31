-- One Item Fulfillment per sales order — the DB half of the guard.
--
-- Invoicing from the completion process transforms the SO into a NetSuite
-- invoice. With Advanced Shipping on (this account: SOs move through
-- Pending Fulfillment → Pending Billing), that transform carries ONLY the
-- lines that don't need fulfilling — labor, freight — so an invoice built
-- straight from the SO silently dropped every part. Fulfilling first fixes
-- that, and fulfilling RELIEVES INVENTORY AND POSTS COGS: doing it twice
-- double-relieves stock and double-posts cost.
--
-- NetSuite itself is the source of truth (the route re-queries the SO's
-- fulfillments before it creates one), but a SuiteQL read is not atomic —
-- two admins clicking "Fulfill & Invoice" at the same moment would both
-- see zero. This table's UNIQUE(netsuite_so_id) is the atomic claim: the
-- loser's INSERT gets 23505 and it never calls NetSuite.
--
-- Rows are deleted only when the claim provably created nothing (the
-- re-query comes back with no fulfillment); a claim whose outcome is
-- unknown is KEPT, so the worst case is a stuck sales order a human
-- resolves in NetSuite, never a second fulfillment.
--
-- Written exclusively by /api/vehicle-tracking/invoice with the service
-- role, so RLS is on with no policies — direct client access stays closed.

CREATE TABLE IF NOT EXISTS netsuite_so_fulfillments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- The NetSuite internal id of the sales order. UNIQUE is the whole point
  -- of this table.
  netsuite_so_id TEXT NOT NULL UNIQUE,
  netsuite_fulfillment_id TEXT,
  tranid TEXT,
  -- True once the fulfillment reads back as Shipped (status C) — a Picked or
  -- Packed fulfillment has NOT relieved inventory, so the invoice would come
  -- up short again.
  shipped BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_by UUID REFERENCES profiles(id),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  last_error TEXT
);

COMMENT ON TABLE netsuite_so_fulfillments IS
  'Atomic claim: at most one Item Fulfillment attempt per NetSuite sales order. Fulfilling relieves inventory and posts COGS, so a duplicate is a real accounting error.';
COMMENT ON COLUMN netsuite_so_fulfillments.shipped IS
  'The fulfillment read back as Shipped (status C). False means inventory was NOT relieved yet.';

ALTER TABLE netsuite_so_fulfillments ENABLE ROW LEVEL SECURITY;
