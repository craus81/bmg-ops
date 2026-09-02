-- 250: fleet_checkins status/QC columns change server-side only (audit
-- Stage 8 close).
--
-- The completion ceremony (photos + required tasks + graphics lane + QC
-- stamp, #635 and after) lives in /api/vehicle-tracking/update-status, and
-- the graphics install lane in /api/vehicle-tracking/graphics-install-status
-- — but both were route-level only: migration 224's staff UPDATE policy let
-- any signed-in staff browser write fleet_checkins.status (or the lane, or
-- a QC stamp) directly, skipping photos/tasks/QC/notifications entirely
-- (Round 3, §7.2.6). No app code does such a write — every UI path already
-- calls the routes — so this closes the console/bug path without breaking
-- any flow.
--
-- Same shape as migration 233's privilege-column trigger: a signed-in
-- writer (auth.uid() IS NOT NULL) may update fleet_checkins, but not these
-- columns; service-role callers (the API routes, crons — auth.uid() IS
-- NULL) are exempt. UPDATE only: INSERTs from authenticated clients are
-- already impossible (migration 249).

CREATE OR REPLACE FUNCTION public.deny_checkin_status_bypass()
RETURNS TRIGGER AS $$
BEGIN
  -- Service-role / server-side writers carry no user JWT.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'fleet_checkins.status changes must go through /api/vehicle-tracking/update-status (completion gate)';
  END IF;
  IF NEW.graphics_install_status IS DISTINCT FROM OLD.graphics_install_status THEN
    RAISE EXCEPTION 'graphics_install_status changes must go through /api/vehicle-tracking/graphics-install-status';
  END IF;
  IF NEW.qc_completed_at IS DISTINCT FROM OLD.qc_completed_at
     OR NEW.qc_completed_by IS DISTINCT FROM OLD.qc_completed_by THEN
    RAISE EXCEPTION 'QC stamps are written by the completion gate, not directly';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

DROP TRIGGER IF EXISTS trg_deny_checkin_status_bypass ON public.fleet_checkins;
CREATE TRIGGER trg_deny_checkin_status_bypass
  BEFORE UPDATE ON public.fleet_checkins
  FOR EACH ROW
  EXECUTE FUNCTION public.deny_checkin_status_bypass();

COMMENT ON FUNCTION public.deny_checkin_status_bypass() IS
  'Migration 250: the vehicle completion gate is server-enforced. Signed-in clients cannot change fleet_checkins.status, graphics_install_status, or the QC stamp columns directly — those go through the vehicle-tracking API routes, which run the photos/tasks/lane checks. Service-role callers (auth.uid() IS NULL) are exempt.';
