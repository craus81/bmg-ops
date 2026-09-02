-- Migration 251: link an estimate to the CRM lead it was quoted for.
--
-- Since the lead tier (owner decision 2026-08-30) a new CRM record is a
-- LEAD — a prospects row with netsuite_id null — and only becomes a
-- NetSuite customer when it's promoted. estimates.customer_id references
-- customers(id), the NetSuite mirror, so a lead's estimate could not point
-- at anything: the builder kept the NAME and left customer_id null.
--
-- That silently disabled the Send for Approval button (gated on a customer
-- id), skipped customer defaults, left the approval email with no
-- recipients to prefill, and forced promotion to guess the lead by matching
-- the company name — which gives up whenever the name was edited or two
-- leads share it.
--
-- prospect_id is that missing half. An estimate now carries whichever side
-- it belongs to: customer_id for a NetSuite customer, prospect_id for a
-- lead. Promotion stamps customer_id and leaves prospect_id in place, so
-- the trail from lead to won deal survives.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimates_prospect ON estimates(prospect_id) WHERE prospect_id IS NOT NULL;
