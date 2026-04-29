-- Migration 088: T1.6 Sales → Ops handoff 3-layer install context
--
-- Adds FleetSuite-owned context fields across the customer/estimate/quote/
-- purchase_order/fleet_checkin chain so install instructions, on-site
-- contact, and delivery preferences propagate from the point of sale
-- through to the installer's pick list.
--
-- IMPORTANT: the new columns on the customers table are FleetSuite-owned.
-- The hourly NetSuite sync (src/app/api/cron/netsuite-sync/route.ts) only
-- updates NS-sourced fields (company_name, email, phone, address, spend
-- rollups) via the upsert's SET list — new columns here are never
-- included in that payload and therefore never clobbered on resync.

-- ═══════════ customers — operations defaults ═══════════
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS delivery_instructions TEXT,
  ADD COLUMN IF NOT EXISTS billing_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS billing_contact_email TEXT,
  ADD COLUMN IF NOT EXISTS ap_email TEXT,
  ADD COLUMN IF NOT EXISTS default_ship_to JSONB,
  ADD COLUMN IF NOT EXISTS account_owner_id UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

COMMENT ON COLUMN customers.delivery_instructions IS 'FleetSuite-owned. Default delivery instructions applied to new estimates for this customer.';
COMMENT ON COLUMN customers.billing_contact_name IS 'FleetSuite-owned. Customer-side AP/billing contact name.';
COMMENT ON COLUMN customers.billing_contact_email IS 'FleetSuite-owned. Customer-side billing contact email.';
COMMENT ON COLUMN customers.ap_email IS 'FleetSuite-owned. Customer AP email for invoices.';
COMMENT ON COLUMN customers.default_ship_to IS 'FleetSuite-owned. Default ship-to address block (name, address, city, state, zip).';
COMMENT ON COLUMN customers.account_owner_id IS 'FleetSuite-owned. Sales rep who owns this account (optional).';
COMMENT ON COLUMN customers.internal_notes IS 'FleetSuite-owned. Free-form ops notes about this customer.';

CREATE INDEX IF NOT EXISTS idx_customers_account_owner ON customers(account_owner_id) WHERE account_owner_id IS NOT NULL;

-- ═══════════ estimates — install context ═══════════
ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS install_instructions TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_preferences TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

COMMENT ON COLUMN estimates.install_instructions IS 'Job-specific install instructions. Pre-filled from customers.delivery_instructions on create.';
COMMENT ON COLUMN estimates.internal_notes IS 'Ops-only notes not shown on the customer-facing PDF (unlike estimates.notes).';

-- ═══════════ estimate_line_items — per-line notes ═══════════
ALTER TABLE estimate_line_items
  ADD COLUMN IF NOT EXISTS notes TEXT;

-- ═══════════ quotes — parallel context fields ═══════════
-- quotes (migration 022) pushes to NS as Estimate records; mirror the
-- same context fields so the conversion path stays consistent.
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS install_instructions TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_preferences TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT;

-- ═══════════ purchase_orders — install context ═══════════
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS install_instructions TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_preferences TEXT,
  ADD COLUMN IF NOT EXISTS source_estimate_id UUID REFERENCES estimates(id);

-- ═══════════ fleet_checkins — install context snapshot ═══════════
ALTER TABLE fleet_checkins
  ADD COLUMN IF NOT EXISTS install_instructions TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_name TEXT,
  ADD COLUMN IF NOT EXISTS on_site_contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS delivery_preferences TEXT,
  ADD COLUMN IF NOT EXISTS source_estimate_id UUID REFERENCES estimates(id);

COMMENT ON COLUMN fleet_checkins.install_instructions IS 'Snapshot from the originating estimate (or PO) at check-in time. Editable post-copy.';

-- ═══════════ cni_jobs — site access notes ═══════════
-- site_contact + address already live on cni_jobs; add site_access_notes
-- specifically for gate codes / parking / access instructions that don't
-- belong in the generic address block.
ALTER TABLE cni_jobs
  ADD COLUMN IF NOT EXISTS site_access_notes TEXT;
