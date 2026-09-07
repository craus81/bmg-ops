-- Migration 263: lead lifecycle (§7.4 item 9, R3-18)
--
-- Deals could be marked lost but no reason was ever captured — the funnel
-- showed WHAT died, never WHY. And migration 059 dropped the 'lost'
-- record status entirely (059 kept 'nurturing' in the CHECK, but nothing
-- in the app ever set it), so a dead record could only sit as 'active'
-- forever, polluting every active-lead view.

ALTER TABLE prospect_opportunities ADD COLUMN IF NOT EXISTS lost_reason TEXT;
ALTER TABLE prospect_opportunities DROP CONSTRAINT IF EXISTS prospect_opportunities_lost_reason_check;
ALTER TABLE prospect_opportunities ADD CONSTRAINT prospect_opportunities_lost_reason_check
  CHECK (lost_reason IS NULL OR lost_reason IN ('price', 'timing', 'competitor', 'no_response', 'other'));
ALTER TABLE prospect_opportunities ADD COLUMN IF NOT EXISTS lost_note TEXT;

COMMENT ON COLUMN prospect_opportunities.lost_reason IS
  'Migration 263: why the deal was lost — required by the UI when a deal is marked lost; cleared when it reopens.';

-- Restore 'lost' on records (dropped by 059). 'converted' stays the
-- promotion path''s to set; the UI offers active/nurturing/lost only.
ALTER TABLE prospects DROP CONSTRAINT IF EXISTS prospects_status_check;
ALTER TABLE prospects ADD CONSTRAINT prospects_status_check
  CHECK (status IN ('active', 'nurturing', 'converted', 'lost'));
