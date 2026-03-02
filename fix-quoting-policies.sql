-- ============================================
-- BMG Ops: Fix Quoting Policies & Storage
-- Run this if setup-quoting.sql partially failed
-- ============================================

-- Drop existing policies for vehicle_templates
DROP POLICY IF EXISTS "templates_read" ON vehicle_templates;
DROP POLICY IF EXISTS "templates_write" ON vehicle_templates;
DROP POLICY IF EXISTS "templates_update" ON vehicle_templates;
DROP POLICY IF EXISTS "templates_delete" ON vehicle_templates;

-- Drop existing policies for quotes
DROP POLICY IF EXISTS "quotes_read" ON quotes;
DROP POLICY IF EXISTS "quotes_write" ON quotes;
DROP POLICY IF EXISTS "quotes_update" ON quotes;
DROP POLICY IF EXISTS "quotes_delete" ON quotes;

-- Drop existing policies for quote_panels
DROP POLICY IF EXISTS "panels_read" ON quote_panels;
DROP POLICY IF EXISTS "panels_write" ON quote_panels;
DROP POLICY IF EXISTS "panels_update" ON quote_panels;
DROP POLICY IF EXISTS "panels_delete" ON quote_panels;

-- Enable RLS (safe to re-run)
ALTER TABLE vehicle_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_panels ENABLE ROW LEVEL SECURITY;

-- Recreate policies: vehicle_templates
CREATE POLICY "templates_read" ON vehicle_templates FOR SELECT USING (true);
CREATE POLICY "templates_write" ON vehicle_templates FOR INSERT WITH CHECK (true);
CREATE POLICY "templates_update" ON vehicle_templates FOR UPDATE USING (true);
CREATE POLICY "templates_delete" ON vehicle_templates FOR DELETE USING (true);

-- Recreate policies: quotes
CREATE POLICY "quotes_read" ON quotes FOR SELECT USING (true);
CREATE POLICY "quotes_write" ON quotes FOR INSERT WITH CHECK (true);
CREATE POLICY "quotes_update" ON quotes FOR UPDATE USING (true);
CREATE POLICY "quotes_delete" ON quotes FOR DELETE USING (true);

-- Recreate policies: quote_panels
CREATE POLICY "panels_read" ON quote_panels FOR SELECT USING (true);
CREATE POLICY "panels_write" ON quote_panels FOR INSERT WITH CHECK (true);
CREATE POLICY "panels_update" ON quote_panels FOR UPDATE USING (true);
CREATE POLICY "panels_delete" ON quote_panels FOR DELETE USING (true);

-- Storage buckets (ON CONFLICT handles existing)
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-templates', 'vehicle-templates', true) ON CONFLICT DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('quote-proofs', 'quote-proofs', true) ON CONFLICT DO NOTHING;

-- Drop & recreate storage policies
DROP POLICY IF EXISTS "templates_storage_read" ON storage.objects;
DROP POLICY IF EXISTS "templates_storage_write" ON storage.objects;
DROP POLICY IF EXISTS "proofs_storage_read" ON storage.objects;
DROP POLICY IF EXISTS "proofs_storage_write" ON storage.objects;

CREATE POLICY "templates_storage_read" ON storage.objects FOR SELECT USING (bucket_id = 'vehicle-templates');
CREATE POLICY "templates_storage_write" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'vehicle-templates');
CREATE POLICY "proofs_storage_read" ON storage.objects FOR SELECT USING (bucket_id = 'quote-proofs');
CREATE POLICY "proofs_storage_write" ON storage.objects FOR INSERT WITH CHECK (bucket_id = 'quote-proofs');
