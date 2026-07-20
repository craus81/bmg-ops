-- Per-person direct deposit document, alongside the W9 / insurance cert
-- columns from migration 032. Stored as an uploaded document (authorization
-- form / voided check) in R2 — no structured bank account data in the app.
-- Company-level equivalent is companies.direct_deposit_file_path (165).

ALTER TABLE cni_profiles ADD COLUMN IF NOT EXISTS direct_deposit_file_path TEXT;
