-- Phase 3 of pay splits (docs/pay-splits-design.md): per-job payout mode.
--
--   company    — today's flow: one invoice, one NetSuite bill to the company.
--   individual — the app generates one draft payout per employee from their
--                credits; admin approves each, creates the vendor bill in
--                NetSuite manually, and records the bill id per payout. No
--                job-level invoice in this mode.

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS payout_mode TEXT NOT NULL DEFAULT 'company'
  CHECK (payout_mode IN ('company', 'individual'));
