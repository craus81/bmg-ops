-- Migration 173: at-risk report actions
-- The at-risk list becomes workable: assign an account owner, keep notes
-- (customers.account_owner_id / internal_notes already exist from 080),
-- and dismiss accounts that no longer apply. Dismissed accounts drop out
-- of the report, the dashboard queue count, and the daily cron alert
-- until restored.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS at_risk_dismissed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS at_risk_dismissed_by UUID REFERENCES profiles(id);
