-- Proactive customer notifications + weekly digest: per-customer opt-outs.
-- Both default ON — the whole point of Tier 3 is proactive transparency —
-- and the notify/digest code checks these before sending. (The customers
-- table is the NetSuite-synced base table; no CREATE migration exists for
-- it, so these ALTERs are the schema record.)

ALTER TABLE customers ADD COLUMN IF NOT EXISTS notify_status_emails BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS weekly_digest BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN customers.notify_status_emails IS 'Send this customer completed/shipped status emails.';
COMMENT ON COLUMN customers.weekly_digest IS 'Include this customer in the weekly vehicle summary email.';
