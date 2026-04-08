-- Migration 053: Prospect CRM — contacts, opportunities, tags, activities

-- Multiple contacts per prospect
CREATE TABLE IF NOT EXISTS prospect_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  email TEXT,
  phone TEXT,
  is_decision_maker BOOLEAN DEFAULT false,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_contacts_prospect ON prospect_contacts(prospect_id);

-- Opportunities / deals within a prospect
CREATE TABLE IF NOT EXISTS prospect_opportunities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('tech_install', 'graphics', 'rebrand', 'fleet_wrap', 'other')),
  stage TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'quoted', 'negotiating', 'won', 'lost')),
  value NUMERIC(12,2),
  notes TEXT,
  expected_close_date DATE,
  closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_opps_prospect ON prospect_opportunities(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospect_opps_stage ON prospect_opportunities(stage);

-- Tags for prospects (for email campaigns, filtering)
CREATE TABLE IF NOT EXISTS prospect_tags (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  auto_generated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(prospect_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_prospect_tags_tag ON prospect_tags(tag);
CREATE INDEX IF NOT EXISTS idx_prospect_tags_prospect ON prospect_tags(prospect_id);

-- Activity log (calls, emails, notes, meetings)
CREATE TABLE IF NOT EXISTS prospect_activities (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  prospect_id UUID NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('call', 'email', 'note', 'meeting', 'quote_sent', 'status_change')),
  summary TEXT NOT NULL,
  details TEXT,
  contact_id UUID REFERENCES prospect_contacts(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prospect_activities_prospect ON prospect_activities(prospect_id);
CREATE INDEX IF NOT EXISTS idx_prospect_activities_type ON prospect_activities(type);

-- Add status field to prospects for pipeline tracking
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active' CHECK (status IN ('active', 'nurturing', 'converted', 'lost', 'inactive'));
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS converted_customer_id TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS location_count INTEGER DEFAULT 1;

-- RLS for all new tables
ALTER TABLE prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_activities ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage prospect contacts" ON prospect_contacts FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
CREATE POLICY "Internal staff can manage prospect opportunities" ON prospect_opportunities FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
CREATE POLICY "Internal staff can manage prospect tags" ON prospect_tags FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
CREATE POLICY "Internal staff can manage prospect activities" ON prospect_activities FOR ALL TO authenticated USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());
