-- Migration 225: one upfit project per estimate
--
-- Convert-to-SO now finds-or-creates the upfit project for the converted
-- estimate (roadmap N2 phase 1). This index is the fan-out guard: two racing
-- conversions (or a retry after a partial failure) can't mint two projects
-- for the same estimate — the second insert 23505s and the route re-selects
-- the winner.
--
-- Dedupe first so the index can't fail on existing data: nothing in the UI
-- ever wrote upfit_projects.estimate_id (the "Pull from NetSuite" box sets
-- estimate_number text only), so duplicates are unlikely — but if any exist,
-- keep the oldest project's link and clear the rest rather than aborting the
-- deploy's migration run.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY estimate_id ORDER BY created_at, id) AS rn
  FROM upfit_projects
  WHERE estimate_id IS NOT NULL
)
UPDATE upfit_projects
SET estimate_id = NULL
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_upfit_projects_estimate
  ON upfit_projects (estimate_id)
  WHERE estimate_id IS NOT NULL;
