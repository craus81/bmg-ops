-- 274: Opportunity change capture (R5-4, Tier 2 forecast item's gate).
--
-- Deal stage/value/close-date writes happen client-side (direct Supabase
-- updates from the CRM), so there is no API chokepoint to instrument — the
-- m195 SECURITY DEFINER row-diff trigger catches them all by construction.
-- The closing-this-month forecast's pipeline-movement digest (R5-8) reads
-- these audit rows: stage changes, dates slipped, value edits, lost
-- reasons — none of which were recorded anywhere before this.
--
-- Actor attribution follows the m195 convention: COALESCE(updated_by,
-- auth.uid()) — browser writes carry the user's JWT; NULL reads as system.
ALTER TABLE prospect_opportunities ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);

-- notes is ignored alongside the bookkeeping columns: free-text editing is
-- chatty and the movement digest never reads it — stage, value,
-- expected_close_date, closed_at, lost_reason/lost_note are the signal.
DROP TRIGGER IF EXISTS trg_audit_prospect_opportunities ON prospect_opportunities;
CREATE TRIGGER trg_audit_prospect_opportunities
  AFTER UPDATE OR DELETE ON prospect_opportunities
  FOR EACH ROW EXECUTE FUNCTION public.audit_row_diff('updated_at', 'updated_by', 'notes');
