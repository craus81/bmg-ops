-- Migration 210: billable customers — who the tech is working for
--
-- Craig 2026-08-18: field techs and CNI installers need to choose the
-- customer they're working for at scan time. Reading Truck and Masterack
-- are merging but for now run separate PO systems, separate AP departments,
-- and different-looking part numbers — and their graphics get installed in
-- the SAME buildings, so the work location can no longer imply the customer
-- (the old rule "any Masterack location bills Masterack LLC" would silently
-- mis-bill Reading work).
--
-- This table is the short pick-list the scan flow and the CNI job form
-- offer — a handful of companies BMG invoices for install work, NOT the
-- full synced NetSuite `customers` table. Adding a customer is an insert,
-- no deploy needed. src/lib/billable-customers.ts carries the same rows as
-- a fallback for sessions that load before this migration applies.
--
-- requires_po drives the Waiting-for-PO gate (with the existing per-part
-- netsuite_parts.requires_po_match): Masterack cuts POs up front, so their
-- scans wait for a PO match. Reading is invoice-first — BMG sends the
-- invoice and Reading cuts a PO after, except in rare pre-PO'd cases — so
-- Reading scans go straight to Ready to Export; when a Reading PO does
-- exist up front, the auto-matcher still attaches it.

CREATE TABLE IF NOT EXISTS billable_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Canonical NetSuite company name: stamped on scans as billable_customer
  -- and matched by findCustomer when the invoice is created. Must equal the
  -- NetSuite customer record's company name or invoicing won't resolve it.
  name TEXT NOT NULL UNIQUE CHECK (length(btrim(name)) > 0),
  -- Short label on the tech-facing buttons ("Reading Truck").
  display_label TEXT NOT NULL,
  -- FALSE = invoice-first: this customer's scans never wait for a PO.
  requires_po BOOLEAN NOT NULL DEFAULT TRUE,
  -- Other names the same customer appears under in part tags / old scans,
  -- for the fuzzy match in src/lib/billable-customers.ts.
  aliases TEXT[] NOT NULL DEFAULT '{}',
  sort_order INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE billable_customers IS
  'Pick-list of companies BMG invoices for install work — what techs/installers choose at scan time. name must equal the NetSuite customer company name. requires_po FALSE = invoice-first (scans skip the Waiting-for-PO gate).';

-- Techs and installers read the list client-side on the scan page; writes
-- stay service-role / SQL only (no write policies).
ALTER TABLE billable_customers ENABLE ROW LEVEL SECURITY;
CREATE POLICY billable_customers_read ON billable_customers
  FOR SELECT TO authenticated USING (true);

INSERT INTO billable_customers (name, display_label, requires_po, aliases, sort_order) VALUES
  ('Masterack LLC', 'Masterack', TRUE, ARRAY['Masterack'], 10),
  ('Reading Equipment and Distribution', 'Reading Truck', FALSE, ARRAY['Reading Truck', 'Reading'], 20),
  ('Designs That Stick', 'Designs That Stick', TRUE, ARRAY[]::TEXT[], 30)
ON CONFLICT (name) DO NOTHING;
