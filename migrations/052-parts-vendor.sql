-- Migration 052: Add vendor field to netsuite_parts for vendor tag display

ALTER TABLE netsuite_parts ADD COLUMN IF NOT EXISTS vendor TEXT;
