-- Signature logo toggle (follow-up to 217): when on, the company logo
-- (wrap_quote_settings.company.logo_path — the same letterhead logo the
-- quote/estimate documents use) renders under the user's signature text on
-- every composed customer email. Per-user opt-in on Settings, resolved
-- server-side by getEmailSignature (src/lib/email-signature.ts).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS email_signature_logo BOOLEAN NOT NULL DEFAULT false;
