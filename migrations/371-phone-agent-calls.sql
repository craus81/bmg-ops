-- After-hours AI phone agent (Retell) call summaries.
--
-- Retell answers the main line after hours and POSTs each finished call to
-- /api/webhooks/retell. The call lands in the same phone_call_events log the
-- Dialpad caller-ID webhook writes (provider = 'retell'), with what the
-- agent took down, and every admin gets the summary by email.

ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS caller_name TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS caller_company TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS caller_email TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS callback_number TEXT;
-- quote / status / billing / other, as the agent classified it.
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS call_reason TEXT;
-- SO, estimate number or VIN the caller gave.
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS caller_reference TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS urgent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS recording_url TEXT;
-- Stamped once the admin emails go out, so a webhook retry never re-sends.
ALTER TABLE phone_call_events ADD COLUMN IF NOT EXISTS summary_emailed_at TIMESTAMPTZ;

-- Who gets the after-hours call emails, whatever their role (Craig,
-- 2026-10-14: Valarie, Harold, Zach, Craig and Jessie). Seeded by first
-- name; flip the flag on a profile to add or drop someone.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS after_hours_call_emails BOOLEAN NOT NULL DEFAULT false;
UPDATE profiles SET after_hours_call_emails = true
WHERE status = 'approved'
  AND COALESCE(deactivated, false) = false
  AND after_hours_call_emails = false
  AND lower(split_part(trim(full_name), ' ', 1)) IN ('valarie', 'harold', 'zach', 'zachary', 'craig', 'jessie');
