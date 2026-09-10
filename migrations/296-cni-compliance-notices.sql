-- Migration 296: CNI compliance autopilot (R6-8)
--
-- Eligibility itself is COMPUTED, not stored: required docs on file,
-- agreements accepted, insurance unexpired. A cached "compliant" flag would
-- go stale the moment a certificate expired overnight and would need its own
-- reconciliation job; the computation cannot.
--
-- What DOES need storing is which warnings have already gone out, so the
-- daily sweep pings each threshold once instead of every morning. One row
-- per (subject, threshold, expiry): keying on the expiry date means a
-- RENEWED certificate re-arms every threshold automatically — the new date
-- has no notices against it — without anyone having to clear anything.

CREATE TABLE IF NOT EXISTS cni_compliance_notices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('company', 'installer')),
  subject_id UUID NOT NULL,
  -- Days before expiry this notice was for; 0 means the lapse itself.
  threshold INT NOT NULL,
  -- The expiry date the notice was about. A renewal changes this, which
  -- re-arms the whole ladder for the new date.
  expiry DATE NOT NULL,
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subject_type, subject_id, expiry, threshold)
);

CREATE INDEX IF NOT EXISTS idx_cni_compliance_notices_subject
  ON cni_compliance_notices(subject_type, subject_id);

COMMENT ON TABLE cni_compliance_notices IS
  'Migration 296: one row per compliance warning already sent, keyed by (subject, expiry, threshold) so each rung of the 30/14/7/3/lapsed ladder fires once — and a renewed certificate re-arms all of them, because the new expiry has no rows against it.';

ALTER TABLE cni_compliance_notices ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Internal staff read compliance notices' AND tablename = 'cni_compliance_notices') THEN
    CREATE POLICY "Internal staff read compliance notices" ON cni_compliance_notices
      FOR SELECT TO authenticated
      USING (public.is_internal_staff());
  END IF;
END $$;
