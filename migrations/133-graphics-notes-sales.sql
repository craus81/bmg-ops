-- Sales couldn't post notes on graphics jobs: migration 011 gave the sales
-- role SELECT on graphics_status_history (the job activity/notes feed) but
-- left the INSERT policy from 010 at admin + production only, so a sales
-- user's note was silently rejected by RLS. (Migration 027's broader
-- is_internal_staff policies use different policy names and may not exist
-- on databases that were migrated by hand.)
--
-- Anyone who can see the graphics board should be able to comment on a job:
-- admin, production, graphics_production, and sales.
DROP POLICY IF EXISTS graphics_history_insert ON graphics_status_history;
CREATE POLICY graphics_history_insert ON graphics_status_history FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
      AND role IN ('admin', 'production', 'graphics_production', 'sales') AND status = 'approved')
  );

-- Same gap for the select policy on modern role names: 011 predates the
-- graphics_production role, so include it here too.
DROP POLICY IF EXISTS graphics_history_select ON graphics_status_history;
CREATE POLICY graphics_history_select ON graphics_status_history FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid()
      AND role IN ('admin', 'production', 'graphics_production', 'sales') AND status = 'approved')
  );
