-- Migration 058: PO matching rules for scan exports

-- Flag on parts: does this part require a PO match before export?
ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS requires_po_match BOOLEAN DEFAULT true;

-- Billable customers without POs (e.g., Designs That Stick / Uhaul) don't need PO match
-- Admin can toggle per-part, but also set a default per billable_customer here:
-- UPDATE netsuite_parts SET requires_po_match = false WHERE billable_customer = 'Designs That Stick';
