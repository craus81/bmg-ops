-- Migration 093: Add missing updated_at column to job_tasks
--
-- Migration 045 created a BEFORE UPDATE trigger on job_tasks that does
-- `NEW.updated_at = NOW()`, but migration 025 never added an updated_at
-- column to the table. As a result every UPDATE on job_tasks (e.g.
-- toggling a checklist item from CompletionModal) fails with a 400 from
-- PostgREST because the trigger references a missing column.
--
-- Add the column. Default to NOW() so existing rows get a sensible value.

ALTER TABLE job_tasks
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
