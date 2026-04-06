-- Migration: Add customer_supplied category and supplier/proof fields to graphics_jobs

-- Drop the old check constraint and add updated one with customer_supplied
ALTER TABLE graphics_jobs DROP CONSTRAINT IF EXISTS graphics_jobs_category_check;
ALTER TABLE graphics_jobs ADD CONSTRAINT graphics_jobs_category_check
CHECK (job_category IN ('production', 'proofing', 'internal', 'customer_supplied'));

-- Add supplier and proof_url fields for customer-supplied graphics
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS supplier TEXT;
ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS proof_url TEXT;
