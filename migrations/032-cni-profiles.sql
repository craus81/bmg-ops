-- CNI Profiles: Extended installer profile data for Certified Network Installers
-- Separates CNI-specific fields from the core profiles table

CREATE TABLE IF NOT EXISTS cni_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id) UNIQUE NOT NULL,

  -- A. Basic Profile (visible to CNI)
  company_name TEXT,
  primary_contact_name TEXT,
  phone TEXT,
  business_address JSONB DEFAULT '{}'::jsonb,  -- { street, city, state, zip }
  service_area JSONB DEFAULT '{}'::jsonb,      -- { type: 'radius'|'zips'|'states', value: ... }
  coverage_radius_miles INT,

  -- B. Capabilities & Services (visible)
  service_types TEXT[] DEFAULT '{}',             -- graphics_install, tech_install, upfitting, removal_rebrand
  equipment_capabilities TEXT[] DEFAULT '{}',    -- indoor, outdoor, lift_bucket, shop, mobile
  skill_level TEXT,                              -- junior, standard, senior (optional future)

  -- C. Availability (visible)
  availability_status TEXT DEFAULT 'available' CHECK (availability_status IN ('available', 'limited', 'unavailable')),
  availability_notes TEXT,

  -- D. Compliance (visible + required) — NO financial data in app
  w9_file_path TEXT,
  insurance_cert_path TEXT,
  insurance_expiry DATE,
  terms_accepted_at TIMESTAMPTZ,
  install_expectations_accepted_at TIMESTAMPTZ,
  timeline_agreement_accepted_at TIMESTAMPTZ,

  -- F. Performance Tracking (internal only)
  completion_reliability TEXT DEFAULT 'good' CHECK (completion_reliability IN ('good', 'late_flags', 'at_risk')),
  photo_quality TEXT DEFAULT 'good' CHECK (photo_quality IN ('pass', 'conditional', 'fail_trends')),
  communication_rating TEXT DEFAULT 'responsive' CHECK (communication_rating IN ('responsive', 'slow', 'difficult')),
  jobs_completed INT DEFAULT 0,
  jobs_on_time INT DEFAULT 0,

  -- H. Risk Flags/Tags (internal only)
  risk_tags TEXT[] DEFAULT '{}',    -- at_risk, needs_review, preferred, do_not_assign

  -- I. Referral Tracking (future)
  referred_by UUID REFERENCES profiles(id),

  -- Metadata
  profile_complete BOOLEAN DEFAULT FALSE,
  onboarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cni_profiles_user_id ON cni_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_cni_profiles_availability ON cni_profiles(availability_status);
CREATE INDEX IF NOT EXISTS idx_cni_profiles_service_types ON cni_profiles USING GIN(service_types);
CREATE INDEX IF NOT EXISTS idx_cni_profiles_risk_tags ON cni_profiles USING GIN(risk_tags);

-- RLS
ALTER TABLE cni_profiles ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE POLICY "Admin full access to cni_profiles"
  ON cni_profiles FOR ALL
  TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

-- Installers can read and update their own profile (visible fields only enforced in app logic)
CREATE POLICY "Installers can view own cni_profile"
  ON cni_profiles FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Installers can update own cni_profile"
  ON cni_profiles FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Installers can create their own profile
CREATE POLICY "Installers can create own cni_profile"
  ON cni_profiles FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());
