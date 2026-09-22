-- Migration 306: self-serve customer notification preferences (R6-11).
--
-- Two layers, because that is what the senders can actually honour:
--
--   * company level (customers.*) — the gate every automatic send already
--     reads. notify_status_emails and weekly_digest exist (156/171);
--     notify_estimate_reminders is new.
--   * contact level (external_contacts.*) — a NULLABLE override per
--     person. NULL means "follow the company setting", which is a real
--     third state, not a disguised false: a contact who has never opened
--     the preferences page has expressed no opinion, and treating that as
--     "off" would silently stop mail they still want.
--
-- notify_estimate_reminders defaults to TRUE on purpose, unlike the two
-- opt-IN flags beside it. Estimate approval reminders are unconditional
-- today — the quote-followup cron has no customer gate at all — so
-- defaulting it false would quietly stop chasing every open quote in the
-- system the moment this deploys. That is a business decision, not a
-- migration's to make. Staff and the customer can both turn it off.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS notify_estimate_reminders BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE external_contacts
  ADD COLUMN IF NOT EXISTS notify_status_emails BOOLEAN,
  ADD COLUMN IF NOT EXISTS weekly_digest BOOLEAN,
  ADD COLUMN IF NOT EXISTS notify_estimate_reminders BOOLEAN,
  ADD COLUMN IF NOT EXISTS prefs_updated_at TIMESTAMPTZ,
  -- 'portal' when the customer set it themselves, 'staff' when we did.
  -- Worth knowing which: a staff member should think twice before
  -- re-enabling something the customer switched off.
  ADD COLUMN IF NOT EXISTS prefs_updated_via TEXT
    CHECK (prefs_updated_via IS NULL OR prefs_updated_via IN ('portal', 'staff'));

COMMENT ON COLUMN customers.notify_estimate_reminders IS 'Send this customer automatic reminders about estimates awaiting approval. Defaults true because these sends were previously unconditional.';
COMMENT ON COLUMN external_contacts.notify_status_emails IS 'Per-contact override of customers.notify_status_emails. NULL = follow the company setting.';
COMMENT ON COLUMN external_contacts.weekly_digest IS 'Per-contact override of customers.weekly_digest. NULL = follow the company setting.';
COMMENT ON COLUMN external_contacts.notify_estimate_reminders IS 'Per-contact override of customers.notify_estimate_reminders. NULL = follow the company setting.';
COMMENT ON COLUMN external_contacts.prefs_updated_via IS 'Who last changed this contact''s email preferences: portal (the customer) or staff.';
