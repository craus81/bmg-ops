-- Migration 076: Expand upfit project status pipeline with intermediate steps
-- Adds: parts_arrived, parts_in_stock, scheduled_dropoff, scheduled_build,
-- scheduled_pickup so the workflow matches how a project actually moves
-- (order parts → receive → stock → drop off vehicle → build → pickup → done).

ALTER TABLE upfit_projects DROP CONSTRAINT IF EXISTS upfit_projects_status_check;

ALTER TABLE upfit_projects ADD CONSTRAINT upfit_projects_status_check CHECK (status IN (
  'opportunity',
  'estimate',
  'sold',
  'parts_ordered',
  'parts_arrived',
  'parts_in_stock',
  'scheduled_dropoff',
  'scheduled_build',
  'in_progress',
  'scheduled_pickup',
  'completed',
  'cancelled'
));

-- Migrate any existing 'scheduled' rows to 'scheduled_build' since that matches
-- the old intent most closely.
UPDATE upfit_projects SET status = 'scheduled_build' WHERE status = 'scheduled';
