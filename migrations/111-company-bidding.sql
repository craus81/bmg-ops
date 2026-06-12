-- Phase 2 of pay splits (docs/pay-splits-design.md): company-level
-- bidding/invites. Invites target a COMPANY (delivered to all its
-- installers); any member's bid counts as the company's bid; selecting a
-- winner assigns the company.

ALTER TABLE cni_job_invites ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES cni_companies(id);
ALTER TABLE cni_job_invites ALTER COLUMN installer_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cni_job_invites_job_company
  ON cni_job_invites(job_id, company_id) WHERE company_id IS NOT NULL;

ALTER TABLE cni_job_bids ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES cni_companies(id);
CREATE INDEX IF NOT EXISTS idx_cni_job_bids_company ON cni_job_bids(company_id) WHERE company_id IS NOT NULL;

-- Backfill legacy rows through the installer's company.
UPDATE cni_job_invites i
SET company_id = cp.company_id
FROM cni_profiles cp
WHERE i.company_id IS NULL AND i.installer_id IS NOT NULL AND cp.user_id = i.installer_id;

UPDATE cni_job_bids b
SET company_id = cp.company_id
FROM cni_profiles cp
WHERE b.company_id IS NULL AND cp.user_id = b.installer_id;

-- Any member of the invited company sees the invite; members also see their
-- company's bids (so a coworker knows the company already responded).
CREATE POLICY "Company members can view company invites" ON cni_job_invites
  FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());

CREATE POLICY "Company members can view company bids" ON cni_job_bids
  FOR SELECT TO authenticated
  USING (company_id IS NOT NULL AND company_id = cni_user_company_id());

-- Bids must carry the bidder's own company (or none, for unlinked legacy
-- profiles) — recreate the insert policy with that check.
DROP POLICY IF EXISTS "installer_create_own_bids" ON cni_job_bids;
CREATE POLICY "installer_create_own_bids" ON cni_job_bids
  FOR INSERT TO authenticated
  WITH CHECK (
    installer_id = auth.uid()
    AND (company_id IS NULL OR company_id = cni_user_company_id())
  );
