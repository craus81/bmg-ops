-- Add sales role support
-- Sales users can view graphics jobs and customers, use estimating tool

-- Update graphics_jobs RLS to include sales role (read-only for sales)
DROP POLICY IF EXISTS graphics_jobs_select ON graphics_jobs;
CREATE POLICY graphics_jobs_select ON graphics_jobs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production', 'sales') AND status = 'approved')
  );

-- Sales can create graphics jobs (e.g. from estimating)
DROP POLICY IF EXISTS graphics_jobs_insert ON graphics_jobs;
CREATE POLICY graphics_jobs_insert ON graphics_jobs FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production', 'sales') AND status = 'approved')
  );

-- Only admin and production can update graphics jobs (status changes, etc.)
-- Sales can view but not modify production workflow
DROP POLICY IF EXISTS graphics_jobs_update ON graphics_jobs;
CREATE POLICY graphics_jobs_update ON graphics_jobs FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production') AND status = 'approved')
  );

-- Graphics status history: sales can view
DROP POLICY IF EXISTS graphics_history_select ON graphics_status_history;
CREATE POLICY graphics_history_select ON graphics_status_history FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'production', 'sales') AND status = 'approved')
  );
