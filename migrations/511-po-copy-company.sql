-- Migration 511: the company each purchase order is for, on FleetSuite's copy.
--
-- Books gap (NetSuite Exit Checklist, "Gaps in what's built"; thread
-- "Replacing NetSuite with FleetSuite", 2026-11-03): FleetSuite's copy of a
-- PO (netsuite_vendor_pos, kept by the vendor PO sync) didn't say which
-- company the PO is for, so Books kept its own copy of every Parts Mail bill
-- and every Receive for BMG, and one for 1084 differed from NetSuite on its
-- company. NetSuite makes a PO's bills and item receipts in the PO's
-- subsidiary. The sync (src/lib/vendor-po-sync.ts) now keeps it here, and
-- Parts Mail and Receiving hand it to the own copies, which take the company
-- whose NetSuite subsidiary it is.
--
-- Empty until the sync next reads the PO: a bill or a Receive on a copy that
-- doesn't have it yet asks NetSuite for it first (poCompanyOf), and keeps it.
-- The sync never clears it.

ALTER TABLE public.netsuite_vendor_pos ADD COLUMN IF NOT EXISTS subsidiary_netsuite_id TEXT;

COMMENT ON COLUMN public.netsuite_vendor_pos.subsidiary_netsuite_id IS
  'Migration 511: NetSuite''s internal id for the subsidiary (company) the PO is in, kept by the vendor PO sync, or asked of NetSuite by a bill or a Receive on the PO when the copy has none yet.';
