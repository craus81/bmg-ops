-- Migration 100: Part number on CNI jobs + device capture on CNI VINs
--
-- CNI jobs were previously part-agnostic. Giving a job a part number lets the
-- installer flow behave like the main scan page: completing a VIN logs to
-- scan_logs, and when the part is the Verizon RFID part (06CS901033) the
-- installer first captures the device's serial / IMEI / CCID.
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS part_number TEXT;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS part_description TEXT;
ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS billable_customer TEXT;

-- The captured identifiers are mirrored onto the CNI VIN row so the installer
-- (who can't read scan_logs under RLS) can see what they captured, and
-- scan_log_id links the row that was written to scan_logs (the source of
-- truth for reporting/invoicing) — also used to avoid double-logging.
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS imei TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS iccid TEXT;
ALTER TABLE cni_job_vins ADD COLUMN IF NOT EXISTS scan_log_id UUID REFERENCES scan_logs(id) ON DELETE SET NULL;
