-- Migration 055: Credit applications for net payment terms

CREATE TABLE IF NOT EXISTS credit_applications (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  -- Company info
  company_name TEXT NOT NULL,
  dba_name TEXT,
  business_type TEXT, -- LLC, Corp, Sole Proprietor, etc.
  tax_id TEXT,        -- EIN / Tax ID
  years_in_business INTEGER,
  -- Primary contact
  contact_name TEXT NOT NULL,
  contact_title TEXT,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  -- Address
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  -- AP contact
  ap_contact_name TEXT,
  ap_contact_email TEXT,
  ap_contact_phone TEXT,
  -- Credit details
  requested_terms TEXT DEFAULT 'net_30', -- net_15, net_30, net_45, net_60
  estimated_monthly_volume NUMERIC(12,2),
  -- Trade references
  trade_ref_1_company TEXT,
  trade_ref_1_contact TEXT,
  trade_ref_1_phone TEXT,
  trade_ref_2_company TEXT,
  trade_ref_2_contact TEXT,
  trade_ref_2_phone TEXT,
  trade_ref_3_company TEXT,
  trade_ref_3_contact TEXT,
  trade_ref_3_phone TEXT,
  -- Bank reference
  bank_name TEXT,
  bank_contact TEXT,
  bank_phone TEXT,
  bank_account_type TEXT,
  -- Status
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'more_info')),
  reviewed_by UUID REFERENCES profiles(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  -- Metadata
  submitted_at TIMESTAMPTZ DEFAULT now(),
  prospect_id UUID REFERENCES prospects(id) ON DELETE SET NULL,
  ip_address TEXT
);

CREATE INDEX IF NOT EXISTS idx_credit_apps_status ON credit_applications(status);
CREATE INDEX IF NOT EXISTS idx_credit_apps_submitted ON credit_applications(submitted_at DESC);

-- RLS: internal staff can read/manage, public can insert
ALTER TABLE credit_applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Internal staff can manage credit applications"
  ON credit_applications FOR ALL TO authenticated
  USING (public.is_internal_staff()) WITH CHECK (public.is_internal_staff());

CREATE POLICY "Anyone can submit credit applications"
  ON credit_applications FOR INSERT TO anon, authenticated
  WITH CHECK (true);
