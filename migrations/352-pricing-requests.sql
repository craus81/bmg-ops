-- Migration 352: Masterack pricing requests (owner ask 2026-10-08, from Ashley O.).
--
-- Masterack emails BMG a pricing request (usually just the end company's
-- name and a picture or proof, no part numbers yet). BMG prices it, sends
-- the price like an estimate, and weeks later Masterack's PO arrives with
-- new 02 (graphic) / 06 (install) item numbers. This tracks each request
-- from the email to the PO.
--
-- Owner decision (option C): the request is its own record (company,
-- requester, internal notes, status, the PO it became), and its pricing is
-- an ordinary estimate marked with estimates.pricing_request_id, so the
-- existing send / PDF / approve-or-request-changes page / reminders / file
-- attachments all work unchanged. That estimate is never pushed to NetSuite
-- (Masterack is billed off its PO); the push and convert-to-SO routes refuse
-- it. The request's pictures and proofs are that estimate's estimate_files,
-- so they are already in the send picker.
--
-- When the PO arrives, an admin links its 02 / 06 lines to the request on
-- the PO page: both numbers become NetSuite items at the quoted prices
-- (owner: "both", FleetSuite and NetSuite), the PO lines point at them, and
-- the request shows as On PO.
--
-- No RLS policies: service role only, behind requireFeature(req, 'estimates')
-- in /api/pricing-requests.

CREATE TABLE IF NOT EXISTS pricing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number TEXT NOT NULL UNIQUE,
  -- Who asked (Masterack today; Reading Truck Equipment may follow).
  customer_name TEXT NOT NULL,
  customer_netsuite_id TEXT,
  -- The end company the graphics are for (e.g. "Orkin").
  company_name TEXT NOT NULL,
  contact_name TEXT,
  contact_email TEXT,
  received_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  vehicle TEXT,
  -- Manual end states only; every other stage is read off the estimate and
  -- the PO link (src/lib/pricing-request.ts pricingRequestStage).
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'declined', 'closed')),
  -- Filled when the PO arrives and an admin links it.
  part_number TEXT,
  install_part_number TEXT,
  part_id UUID REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  install_part_id UUID REFERENCES netsuite_parts(id) ON DELETE SET NULL,
  part_price NUMERIC(12, 2),
  install_price NUMERIC(12, 2),
  po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL,
  linked_at TIMESTAMPTZ,
  linked_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pricing_requests_created_idx ON pricing_requests (created_at DESC, id);
CREATE INDEX IF NOT EXISTS pricing_requests_po_idx ON pricing_requests (po_id);
CREATE INDEX IF NOT EXISTS pricing_requests_part_numbers_idx ON pricing_requests (upper(part_number), upper(install_part_number));

ALTER TABLE pricing_requests ENABLE ROW LEVEL SECURITY;

-- Internal notes thread on a request (never shown to the customer).
CREATE TABLE IF NOT EXISTS pricing_request_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_request_id UUID NOT NULL REFERENCES pricing_requests(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pricing_request_notes_request_idx ON pricing_request_notes (pricing_request_id, created_at);

ALTER TABLE pricing_request_notes ENABLE ROW LEVEL SECURITY;

-- The request's price sheet. Newest estimate wins when there is more than one.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS pricing_request_id UUID REFERENCES pricing_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_estimates_pricing_request ON estimates (pricing_request_id) WHERE pricing_request_id IS NOT NULL;
