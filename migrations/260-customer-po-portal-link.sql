-- Customer PO-status portal: one shared link per customer.
--
-- Customers who send us purchase orders (Masterack first, but every
-- customer with POs — owner decision 2026-09-04) get a read-only page
-- showing the status of each PO they sent: received, in design, in
-- production, shipped, installed, fulfilled — a pared-down view of the
-- graphics job board and the PO record. No login: a shared link whose
-- token IS the credential (the approval magic-link pattern, migrations
-- 082/084/153), created and revoked from the customer record.
--
-- FleetSuite-owned columns on customers (migration-080/187 pattern): the
-- NetSuite sync upserts only NS-sourced fields, so nothing here is
-- clobbered on resync.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS portal_token UUID,
  ADD COLUMN IF NOT EXISTS portal_token_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS portal_last_viewed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_portal_token
  ON customers (portal_token) WHERE portal_token IS NOT NULL;

COMMENT ON COLUMN customers.portal_token IS
  'FleetSuite-owned. Shared-link credential for the customer PO-status portal (/portal/<token>, src/app/api/portal/[token]). NULL = no link issued. Regenerating replaces it (old links die); revoking clears it.';
COMMENT ON COLUMN customers.portal_token_created_at IS
  'FleetSuite-owned. When the current portal_token was issued.';
COMMENT ON COLUMN customers.portal_last_viewed_at IS
  'FleetSuite-owned. Last time anyone opened the portal link (stamped by the token route).';
