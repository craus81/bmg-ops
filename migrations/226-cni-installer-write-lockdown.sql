-- Migration 226: CNI installer/company write lockdown (RLS → SELECT-only)
--
-- Follow-up to migration 224, which redefined is_internal_staff() as a real
-- staff allowlist (installers no longer pass it) but deliberately left cni_jobs
-- writable by company members: migration 110's "Company members can update
-- company cni_jobs" grants row-level UPDATE with NO column restriction, so an
-- installer could set any column of their own jobs (pay_per_vehicle,
-- invoice_status, netsuite_bill_id, status). RLS cannot scope columns; 224's
-- header tracked the fix as "reroute the installer writes first, then reduce the
-- policy to SELECT-only."
--
-- That rerouting has now shipped (#641 job lifecycle, #642 photos + messages),
-- so every installer/company-member write to these tables goes through a
-- service-role API route that authorizes the caller (canActOnCniJob) and
-- whitelists the columns. This migration removes the now-unused installer and
-- company INSERT/UPDATE/ALL policies, keeping their SELECT twins so the portal
-- still reads jobs, VINs, photos, and message threads.
--
-- Untouched on purpose:
--   * All SELECT policies — post-224 these (033/034/038 assigned-installer +
--     110/111 company-member) are the ONLY installer read path; dropping one
--     would blind the portal.
--   * is_internal_staff() policies (044) and the admin policies — staff/admin
--     writes on the admin CNI pages ride these and must keep working.
--   * cni_job_bids — its installer INSERT policy already pins installer_id +
--     company_id (111); bidding is a distinct unassigned-job flow, tracked
--     separately.
--   * cni_job_status_history — its "Authenticated users can insert" policy is
--     load-bearing for the AFTER-UPDATE audit trigger (045, non-SECURITY
--     DEFINER, runs under the caller's rights) on admin client-side status
--     changes; scoping it needs its own look, tracked separately.
--   * cni_profiles own-row self-service — outside this table set.
--
-- Runs inside the migrate.mjs per-file transaction; DROP ... IF EXISTS makes it
-- idempotent and independent of whether a given legacy policy is still present.

-- ── cni_jobs: installers/company can no longer UPDATE (reads stay) ──────────
DROP POLICY IF EXISTS "Installers can update assigned cni_jobs" ON cni_jobs;
DROP POLICY IF EXISTS "Company members can update company cni_jobs" ON cni_jobs;

-- ── cni_job_vins: photos_submitted / completion now go through routes ───────
DROP POLICY IF EXISTS "Installers can update cni_job_vins on assigned jobs" ON cni_job_vins;
DROP POLICY IF EXISTS "Company members can update cni_job_vins" ON cni_job_vins;

-- ── cni_job_photos: metadata insert now goes through the route ─────────────
DROP POLICY IF EXISTS "installer_upload_photos" ON cni_job_photos;
DROP POLICY IF EXISTS "Company members can upload cni_job_photos" ON cni_job_photos;

-- ── cni_job_messages: send + read now go through routes ────────────────────
-- The 039 and 110 policies were FOR ALL, which also let a participant UPDATE or
-- DELETE anyone's message on their job (message tamper / read_at spoof). Drop
-- them and re-grant read-only, preserving the exact same job-scope predicates so
-- the portal still shows the thread.
DROP POLICY IF EXISTS "installer_rw_own_job_messages" ON cni_job_messages;
DROP POLICY IF EXISTS "Company members can rw cni_job_messages" ON cni_job_messages;

DROP POLICY IF EXISTS "Installers can read assigned cni_job_messages" ON cni_job_messages;
CREATE POLICY "Installers can read assigned cni_job_messages" ON cni_job_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM cni_jobs WHERE id = job_id AND assigned_installer_id = auth.uid())
  );

DROP POLICY IF EXISTS "Company members can read cni_job_messages" ON cni_job_messages;
CREATE POLICY "Company members can read cni_job_messages" ON cni_job_messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM cni_jobs
      WHERE id = job_id
        AND assigned_company_id IS NOT NULL
        AND assigned_company_id = cni_user_company_id()
    )
  );
