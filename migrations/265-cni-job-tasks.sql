-- Migration 265: CNI install task checklist (§7.4 item 13's open floor build)
--
-- A CNI job carried scope text, photos, and per-VIN completion — but no
-- procedural checklist: the steps photos can't show (prep, wiring, torque,
-- cleanup, customer sign-off) lived in the coordinator's head. One row per
-- task per job, authored by the coordinator on the job page, checked off by
-- the installer; required tasks gate "Mark Job Complete" and the closure
-- check. Deliberately per-JOB, complementing (never duplicating) the
-- per-VIN photo-coverage machinery in cni_job_photos.
--
-- Writes go through /api/cni/job-tasks on the service role ONLY, per the
-- 226/253 installer-write lockdown; RLS grants SELECT to internal staff
-- and to the assigned installer/company so both portals can render the
-- list browser-side.

CREATE TABLE IF NOT EXISTS cni_job_tasks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES cni_jobs(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  required BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  completed_by UUID REFERENCES profiles(id),
  completed_by_name TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cni_job_tasks_job ON cni_job_tasks(job_id);

ALTER TABLE cni_job_tasks ENABLE ROW LEVEL SECURITY;

-- 253-style sweep: no non-SELECT policy survives on this table, ever.
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cni_job_tasks' AND cmd <> 'SELECT'
  LOOP
    EXECUTE format('DROP POLICY %I ON cni_job_tasks', pol.policyname);
  END LOOP;
END $$;

-- Staff read everything; the assigned installer / company reads their job's
-- tasks (same scoping as cni_job_vins' company policy from migration 110).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'cni_job_tasks'
      AND policyname = 'cni_job_tasks_select'
  ) THEN
    CREATE POLICY cni_job_tasks_select ON cni_job_tasks
      FOR SELECT TO authenticated
      USING (
        public.is_internal_staff()
        OR EXISTS (
          SELECT 1 FROM cni_jobs j
          WHERE j.id = cni_job_tasks.job_id
            AND (
              j.assigned_installer_id = auth.uid()
              OR (j.assigned_company_id IS NOT NULL AND j.assigned_company_id = public.cni_user_company_id())
            )
        )
      );
  END IF;
END $$;

COMMENT ON TABLE cni_job_tasks IS
  'Migration 265: per-CNI-job install checklist. Coordinator-authored, installer-checked; required rows gate Mark Job Complete and the closure check. Writes via /api/cni/job-tasks (service role) only.';
