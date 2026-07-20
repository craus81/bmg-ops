-- Company-level direct deposit document, alongside the W9 / insurance cert
-- columns from migration 110. Stored as an uploaded document (authorization
-- form / voided check) in R2 — no structured bank account data in the app,
-- same policy as cni_profiles (migration 032).

ALTER TABLE companies ADD COLUMN IF NOT EXISTS direct_deposit_file_path TEXT;
