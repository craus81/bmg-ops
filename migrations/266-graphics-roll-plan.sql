-- Migration 266: roll-nesting reaches production (§7.4 item 13's second
-- floor build — the Stage 5 enhancement left open by design).
--
-- The nesting engine (roll-nesting.ts + the RollNesting canvas) has been
-- wrap-quote-only; production jobs got a flattened text summary and the
-- material log stayed manual, inventory-blind typing. The job page's new
-- Roll Plan card lays the job's pieces on the roll with the same engine
-- and writes the computed usage into graphics_job_materials in one click.
-- This column is the plan's home — the same single-JSONB pattern as
-- wrap_quotes.nesting (migration 180): { v, config, sets, pieceDefs,
-- placements, savedAt }.

ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS nesting JSONB;

COMMENT ON COLUMN graphics_jobs.nesting IS
  'Migration 266: the production roll plan — { v, config (RollConfig), sets, pieceDefs [{name,w,h,qty}], placements (PlacementMap), savedAt }. Written by the job page''s Roll Plan card; computeUsage() over it feeds graphics_job_materials.';
