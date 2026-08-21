-- Per-user email signature (Valarie's ask, 2026-08-21): plain text written
-- on Settings, appended by the server to every staff-composed customer
-- email (estimate approvals, invoices, wrap quotes, statements, proofs,
-- install guides) — so the preview shows exactly what goes out. Automated
-- sends (crons, digests, invites) have no composing user and none.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_signature TEXT;
