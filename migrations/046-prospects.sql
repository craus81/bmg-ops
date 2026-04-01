-- Migration 046: Prospects table for business card scanning + NetSuite push
-- Prospects are local records that can be pushed to NetSuite as Customer or Lead

CREATE TABLE IF NOT EXISTS prospects (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  title VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(255),
  address TEXT,
  city VARCHAR(255),
  state VARCHAR(100),
  zip VARCHAR(20),
  website VARCHAR(255),
  notes TEXT,
  source VARCHAR(50) DEFAULT 'manual',  -- 'manual', 'business_card'
  card_image_url TEXT,                   -- R2 URL of scanned business card
  netsuite_id VARCHAR(50),              -- set after push to NetSuite
  netsuite_type VARCHAR(20),            -- 'customer' or 'lead'
  netsuite_url TEXT,                    -- deep link to NetSuite record
  pushed_at TIMESTAMPTZ,               -- when pushed to NetSuite
  pushed_by UUID REFERENCES auth.users(id),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prospects_company ON prospects(company_name);
CREATE INDEX IF NOT EXISTS idx_prospects_netsuite ON prospects(netsuite_id);
CREATE INDEX IF NOT EXISTS idx_prospects_created ON prospects(created_at DESC);

-- Enable RLS
ALTER TABLE prospects ENABLE ROW LEVEL SECURITY;

-- Internal staff only
CREATE POLICY "prospects_select" ON prospects
  FOR SELECT TO authenticated USING (public.is_internal_staff());
CREATE POLICY "prospects_insert" ON prospects
  FOR INSERT TO authenticated WITH CHECK (public.is_internal_staff());
CREATE POLICY "prospects_update" ON prospects
  FOR UPDATE TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
CREATE POLICY "prospects_delete" ON prospects
  FOR DELETE TO authenticated USING (public.is_internal_staff());

-- Updated_at trigger
CREATE TRIGGER update_prospects_updated_at
  BEFORE UPDATE ON prospects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
