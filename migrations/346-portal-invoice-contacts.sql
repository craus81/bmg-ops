-- Migration 346: per-customer "portal invoice contacts" (owner ask 2026-10-05).
--
-- Some customers (Bodewell first) only pay invoices that someone at BMG keys
-- into the customer's own AP portal. Whenever FleetSuite creates an invoice
-- for one of these customers, the staff listed here get an immediate alert
-- (in-app + push + email with the invoice PDF) to go enter it. Set from
-- Admin → Customer Notifications; empty = no alert.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_invoice_contact_ids UUID[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN customers.portal_invoice_contact_ids IS
  'Staff profile ids alerted to enter each new invoice for this customer in the customer''s AP portal (src/lib/portal-invoice-notify.ts).';
