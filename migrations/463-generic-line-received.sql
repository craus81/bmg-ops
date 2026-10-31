-- Migration 463: a generic part's line (Misc) can be marked received.
--
-- Generic parts (netsuite_parts.is_generic) are tracked per estimate line,
-- by description, rather than per part number: each line is its own
-- purchase request, its own PO line, and is received on its own
-- (src/lib/generic-lines.ts). A line ordered on a PO counts as received
-- from that PO line's quantity_received, whether it was checked in at
-- Receiving or in NetSuite. received_at covers the rest: "Got it" on the
-- job's Parts Readiness card, for things bought at the counter or on a
-- card with no PO. A "Got it" with no request behind it adds one here,
-- status 'ordered', source 'got_it'.

ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;
ALTER TABLE purchase_requests ADD COLUMN IF NOT EXISTS received_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
