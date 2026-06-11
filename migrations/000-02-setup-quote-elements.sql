-- ============================================
-- BMG Ops: Quote Elements Table (Element-Based Quoting)
-- Run this in Supabase SQL Editor
-- ============================================

-- Add new columns to quotes table
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS analysis_version text DEFAULT 'panel_coverage';
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS nesting_result jsonb;

-- Quote Elements (individual graphic pieces for nesting approach)
CREATE TABLE IF NOT EXISTS quote_elements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  element_name text NOT NULL,
  element_type text,                      -- logo, stripe, text_block, graphic, full_panel, decal
  width_in numeric DEFAULT 0,
  height_in numeric DEFAULT 0,
  description text,
  bleed_in numeric DEFAULT 0.5,           -- bleed amount applied per side
  nested_x_in numeric,                    -- x position on roll (inches from left)
  nested_y_in numeric,                    -- y position on roll (inches from top)
  sort_order integer DEFAULT 0
);

-- Enable RLS
ALTER TABLE quote_elements ENABLE ROW LEVEL SECURITY;

-- RLS Policies for quote_elements
DROP POLICY IF EXISTS "elements_read" ON quote_elements;
DROP POLICY IF EXISTS "elements_write" ON quote_elements;
DROP POLICY IF EXISTS "elements_update" ON quote_elements;
DROP POLICY IF EXISTS "elements_delete" ON quote_elements;

CREATE POLICY "elements_read" ON quote_elements FOR SELECT USING (true);
CREATE POLICY "elements_write" ON quote_elements FOR INSERT WITH CHECK (true);
CREATE POLICY "elements_update" ON quote_elements FOR UPDATE USING (true);
CREATE POLICY "elements_delete" ON quote_elements FOR DELETE USING (true);
