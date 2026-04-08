-- Migration 052: Allow POs to skip photo review approval
-- U-Haul and similar jobs don't need photo approval

ALTER TABLE purchase_orders
ADD COLUMN IF NOT EXISTS skip_photo_review BOOLEAN DEFAULT false;
