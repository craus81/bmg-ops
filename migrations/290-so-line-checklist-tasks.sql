-- R6-10: checklist tasks generated from the sales order's own lines.
--
-- Today a vehicle's install checklist comes entirely from a curated
-- template — the same handful of safety/QC items for every job, however
-- many parts the order actually carries. The tech reads the SO on a
-- separate screen (or a printout) to know WHAT to install.
--
-- These columns let one job_tasks row carry a part: which item, how many,
-- how long it should take, and a picture of it. The rows are generated
-- from the linked sales order when install starts.
--
-- The one rule that matters: an SO-line task is NEVER `required`. The
-- completion gate blocks on required tasks, and these rows are synced
-- data — a mirror that dropped a line, or a service item the type filter
-- let through, would strand a finished vehicle nobody can close. Required
-- items stay what they have always been: the human-curated template.

ALTER TABLE job_tasks
  -- 'template' = from install_checklist_templates (everything today),
  -- 'so_line'  = generated from a NetSuite sales-order line,
  -- 'manual'   = added by hand on the floor.
  ADD COLUMN IF NOT EXISTS source TEXT
    CHECK (source IN ('template', 'so_line', 'manual')),
  ADD COLUMN IF NOT EXISTS item_number TEXT,
  ADD COLUMN IF NOT EXISTS quantity NUMERIC(12,2),
  -- NULL = nobody has priced this part's labor. NOT zero — zero means
  -- "no labor is charged for this part" (the migration-258 rule), and
  -- showing an unpriced part as 0h would understate the day's work.
  ADD COLUMN IF NOT EXISTS expected_hours NUMERIC(8,2),
  -- netsuite_parts.image_path, copied at generation time so the floor
  -- still sees the picture if the catalog row is later re-photographed.
  ADD COLUMN IF NOT EXISTS image_path TEXT;

COMMENT ON COLUMN job_tasks.source IS
  'Where this task came from: template (curated checklist), so_line (generated from a sales-order line, never required), or manual.';
COMMENT ON COLUMN job_tasks.expected_hours IS
  'netsuite_parts.labor_hours x quantity at generation time. NULL = unpriced, which is not zero.';

-- Existing rows all came from a template.
UPDATE job_tasks SET source = 'template' WHERE source IS NULL;

-- One task per item per job: regenerating cannot double-list a part.
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_tasks_so_line_unique
  ON job_tasks(job_type, job_id, item_number)
  WHERE source = 'so_line' AND item_number IS NOT NULL;
