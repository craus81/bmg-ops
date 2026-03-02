-- ============================================
-- BMG Ops: Quoting / Estimating Tool Schema
-- ============================================

-- Vehicle Templates (1:20 scale EPS files converted to PNG)
CREATE TABLE IF NOT EXISTS vehicle_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,                          -- e.g. "Ford Transit 148 HR"
  make text NOT NULL,                          -- e.g. "Ford"
  model text NOT NULL,                         -- e.g. "Transit"
  year text,                                   -- e.g. "2025"
  variant text,                                -- e.g. "148 High Roof", "Long Wheelbase Med Roof"
  scale text DEFAULT '1:20',                   -- template scale
  overall_length_in numeric,                   -- real-world length in inches
  overall_height_in numeric,                   -- real-world height in inches
  wheelbase_in numeric,                        -- wheelbase in inches
  template_image_path text,                    -- Supabase storage path for PNG preview
  original_file_path text,                     -- Supabase storage path for original EPS
  panel_data jsonb DEFAULT '[]'::jsonb,        -- AI-extracted panel dimensions [{name, width_in, height_in, area_sqft}]
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Quotes
CREATE TABLE IF NOT EXISTS quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_number text NOT NULL,                  -- auto-generated QUO-XXXX
  customer_name text NOT NULL,                 -- customer this quote is for
  vehicle_description text,                    -- e.g. "2025 Ford Transit 148 High Roof"
  template_id uuid REFERENCES vehicle_templates(id),
  proof_image_path text,                       -- Supabase storage path for proof PDF/image
  status text DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),

  -- AI Analysis Results
  ai_analysis jsonb DEFAULT '{}'::jsonb,       -- full AI response stored for reference
  total_vinyl_sqft numeric DEFAULT 0,          -- total estimated vinyl square footage
  coverage_percentage numeric DEFAULT 0,       -- overall coverage %

  -- Pricing
  material_cost_per_sqft numeric DEFAULT 0,    -- $/sqft for material
  labor_cost_per_sqft numeric DEFAULT 0,       -- $/sqft for labor
  material_total numeric DEFAULT 0,            -- material_cost_per_sqft * total_vinyl_sqft
  labor_total numeric DEFAULT 0,               -- labor_cost_per_sqft * total_vinyl_sqft
  subtotal numeric DEFAULT 0,                  -- material_total + labor_total
  markup_percentage numeric DEFAULT 0,         -- optional markup %
  total_price numeric DEFAULT 0,               -- final price

  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Quote Panel Breakdown (per-panel details from AI analysis)
CREATE TABLE IF NOT EXISTS quote_panels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid REFERENCES quotes(id) ON DELETE CASCADE,
  panel_name text NOT NULL,                    -- e.g. "Driver Side", "Passenger Side", "Hood", "Rear"
  panel_area_sqft numeric DEFAULT 0,           -- total panel area
  vinyl_coverage_pct numeric DEFAULT 0,        -- % of panel covered with vinyl (0-100)
  vinyl_sqft numeric DEFAULT 0,               -- panel_area_sqft * coverage_pct / 100
  vinyl_type text,                             -- e.g. "full wrap", "partial", "lettering only"
  notes text,
  sort_order integer DEFAULT 0
);

-- RLS Policies
ALTER TABLE vehicle_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_panels ENABLE ROW LEVEL SECURITY;

-- Templates: admins can read/write, everyone can read
CREATE POLICY "templates_read" ON vehicle_templates FOR SELECT USING (true);
CREATE POLICY "templates_write" ON vehicle_templates FOR INSERT WITH CHECK (true);
CREATE POLICY "templates_update" ON vehicle_templates FOR UPDATE USING (true);
CREATE POLICY "templates_delete" ON vehicle_templates FOR DELETE USING (true);

-- Quotes: admins can CRUD
CREATE POLICY "quotes_read" ON quotes FOR SELECT USING (true);
CREATE POLICY "quotes_write" ON quotes FOR INSERT WITH CHECK (true);
CREATE POLICY "quotes_update" ON quotes FOR UPDATE USING (true);
CREATE POLICY "quotes_delete" ON quotes FOR DELETE USING (true);

-- Quote panels: cascade from quote access
CREATE POLICY "panels_read" ON quote_panels FOR SELECT USING (true);
CREATE POLICY "panels_write" ON quote_panels FOR INSERT WITH CHECK (true);
CREATE POLICY "panels_update" ON quote_panels FOR UPDATE USING (true);
CREATE POLICY "panels_delete" ON quote_panels FOR DELETE USING (true);

-- Storage buckets for templates and proofs
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-templates', 'vehicle-templates', true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('quote-proofs', 'quote-proofs', true) ON CONFLICT DO NOTHING;

-- Storage policies
CREATE POLICY "templates_storage_read" ON storage.objects FOR SELECT USING (bucket_id = 'vehicle-templates');
CREATE POLICY "templates_storage_write" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'vehicle-templates');
CREATE POLICY "proofs_storage_read" ON storage.objects FOR SELECT USING (bucket_id = 'quote-proofs');
CREATE POLICY "proofs_storage_write" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'quote-proofs');
