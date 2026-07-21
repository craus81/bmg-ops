-- Migration 171: customer notifications become opt-IN
-- Automatic customer-facing sends (vehicle complete/shipped emails,
-- graphics shipped email, weekly digest, proof auto-reminders) previously
-- defaulted ON for every customer. Flip both flags to default OFF and
-- clear them for existing customers: nobody gets automatic email unless
-- individually subscribed on the Customer Notifications page. On-demand
-- sends (staff clicks Send and confirms the address) ignore these flags.

ALTER TABLE customers ALTER COLUMN notify_status_emails SET DEFAULT false;
ALTER TABLE customers ALTER COLUMN weekly_digest SET DEFAULT false;

UPDATE customers SET notify_status_emails = false WHERE notify_status_emails = true;
UPDATE customers SET weekly_digest = false WHERE weekly_digest = true;
