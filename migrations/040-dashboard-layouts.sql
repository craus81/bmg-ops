-- Migration 040: Dashboard Layouts
-- Stores per-user customizable dashboard widget layouts

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  layout jsonb NOT NULL DEFAULT '[]'::jsonb,       -- react-grid-layout serialized layout array
  widgets jsonb NOT NULL DEFAULT '[]'::jsonb,       -- array of enabled widget IDs
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(user_id)
);

-- Enable RLS
ALTER TABLE dashboard_layouts ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own layout
CREATE POLICY "Users can read own layout"
  ON dashboard_layouts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own layout"
  ON dashboard_layouts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own layout"
  ON dashboard_layouts FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Index for fast lookup
CREATE INDEX idx_dashboard_layouts_user ON dashboard_layouts(user_id);
