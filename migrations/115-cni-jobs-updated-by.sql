-- Fix: cni_jobs status-change trigger (migration 045's
-- log_cni_job_status_change) references NEW.updated_by, but cni_jobs never had
-- that column — so every status-changing UPDATE errored with
-- "record new has no field updated_by". Add the column the trigger expects;
-- the app sets it on status transitions so the history's changed_by is real.

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES profiles(id);
