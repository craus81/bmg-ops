-- Migration 074: Store billing email recipients per customer
-- Used by the "Email Invoices" flow on the Scans admin page to remember
-- which addresses should receive future invoice emails for each customer.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS billing_emails TEXT[] DEFAULT '{}';
