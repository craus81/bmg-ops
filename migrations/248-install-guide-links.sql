-- Migration 248: install guides join the records they describe (Stage 6).
--
-- The guide was an orphan: customer and vehicle were free text, and nothing
-- referenced a guide from graphics_jobs, fleet_checkins, or cni_jobs —
-- finding "the guide for this Transit" meant eyeballing a flat list, and
-- nothing downstream (the CNI completion gate, the in-shop verification
-- modal) could reach the dimensioned guide at all.
ALTER TABLE install_guides ADD COLUMN IF NOT EXISTS graphics_job_id UUID REFERENCES graphics_jobs(id) ON DELETE SET NULL;
ALTER TABLE install_guides ADD COLUMN IF NOT EXISTS cni_job_id UUID REFERENCES cni_jobs(id) ON DELETE SET NULL;
ALTER TABLE install_guides ADD COLUMN IF NOT EXISTS fleet_checkin_id UUID REFERENCES fleet_checkins(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_install_guides_graphics_job ON install_guides(graphics_job_id) WHERE graphics_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_guides_cni_job ON install_guides(cni_job_id) WHERE cni_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_install_guides_checkin ON install_guides(fleet_checkin_id) WHERE fleet_checkin_id IS NOT NULL;

-- The 213 policy's role array omitted super_admin, locking a pure
-- super_admin account out at the DB (Stage 6 finding). Same fix shape as
-- migrations 233/234: super_admin joins explicitly. ('production' stays for
-- legacy single-role rows 029 didn't migrate.)
DROP POLICY IF EXISTS "install_guides_staff" ON install_guides;
CREATE POLICY "install_guides_staff" ON install_guides FOR ALL TO authenticated USING (
  public.get_my_roles() && ARRAY['admin', 'super_admin', 'sales', 'graphics_production', 'production']
);
