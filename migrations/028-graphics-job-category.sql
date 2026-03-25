-- Migration 028: Add job_category to graphics_jobs for conditional workflow
-- Categories: 'production', 'proofing', 'internal'
-- Production = full workflow (current default)
-- Proofing = design/proof approval only, no production steps
-- Internal = internal projects (e.g. T-Mobile design work)

ALTER TABLE graphics_jobs
ADD COLUMN IF NOT EXISTS job_category TEXT NOT NULL DEFAULT 'production';

-- Add a check constraint for valid values
ALTER TABLE graphics_jobs
ADD CONSTRAINT graphics_jobs_category_check
CHECK (job_category IN ('production', 'proofing', 'internal'));

-- Backfill: all existing jobs are production
UPDATE graphics_jobs SET job_category = 'production' WHERE job_category IS NULL;
