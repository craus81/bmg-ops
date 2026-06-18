-- Per-job device capture: any CNI job can require installers to scan the
-- serial number / IMEI / ICCID per vehicle, not only jobs whose part number
-- is exactly the Verizon RFID part (06CS901033). The Verizon part still
-- auto-triggers capture; this flag adds it for any other job.

ALTER TABLE cni_jobs ADD COLUMN IF NOT EXISTS device_capture BOOLEAN DEFAULT FALSE;
