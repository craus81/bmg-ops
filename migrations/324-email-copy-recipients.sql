-- Record who else an email went to (CC and BCC), next to the To line.
--
-- Resend's bounce webhook covers the whole email and doesn't say which
-- recipient bounced. With only the To line on record, a bounce from a CC'd
-- teammate was reported as "the customer did not get it" (2026-09-23: two
-- approval emails "bounced" while the customers' copies were delivered —
-- the bounce was a CC). Knowing everyone on the email lets the alert say
-- it could have been any of them.

ALTER TABLE email_log ADD COLUMN IF NOT EXISTS copy_recipients TEXT[];
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_email_copies TEXT[];
