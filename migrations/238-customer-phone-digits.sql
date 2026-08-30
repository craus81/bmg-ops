-- Migration 238: normalized phone digits for duplicate detection (audit
-- Stage 1 MAJOR: the duplicate guard was exact-name-only — phone and email
-- were never checked on any create path).
--
-- Phones are stored in mutually inconsistent formats across the app:
-- "(555) 123-4567" from PhoneInput, raw NetSuite strings from the sync,
-- E.164 from the SMS webhook, raw OCR from business-card scans. PostgREST
-- can't digit-strip both sides of a comparison, so each table carries a
-- STORED generated column with digits only; the shared checker
-- (src/lib/customer-dupes.ts) compares on the last 10 digits. NULLIF keeps
-- empty/blank phones NULL so the partial indexes stay small.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS phone_digits TEXT
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), '')) STORED;
CREATE INDEX IF NOT EXISTS idx_prospects_phone_digits
  ON prospects(phone_digits) WHERE phone_digits IS NOT NULL;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_digits TEXT
  GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(phone, ''), '\D', '', 'g'), '')) STORED;
CREATE INDEX IF NOT EXISTS idx_customers_phone_digits
  ON customers(phone_digits) WHERE phone_digits IS NOT NULL;
