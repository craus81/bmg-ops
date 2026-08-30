-- Migration 239: phone digits on prospect_contacts, for caller-ID search
-- (audit Stage 1 MAJOR: "no phone-number search anywhere — the first thing
-- you'd do with caller ID").
--
-- Same shape as migration 238's columns on prospects/customers: a STORED
-- digits-only generated column so universal search can match a typed
-- number against phones stored in any format. A contact's phone often IS
-- the number that calls — the search maps the hit back to the parent
-- prospect record.
ALTER TABLE prospect_contacts ADD COLUMN IF NOT EXISTS phone_digits TEXT
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), '')) STORED;
CREATE INDEX IF NOT EXISTS idx_prospect_contacts_phone_digits
  ON prospect_contacts(phone_digits) WHERE phone_digits IS NOT NULL;
