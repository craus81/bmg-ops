-- Migration 099: Verizon RFID device fields on scan logs
-- For Verizon RFID installs (part 06CS901033) the installer scans three
-- device identifiers off the unit's label in addition to the vehicle VIN:
--   * serial_number — the device serial (SN)
--   * imei          — 15-digit cellular IMEI
--   * iccid         — SIM card ICCID (the "CCID" on the label), ~19-20 digits
-- These are null for every other part.
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS serial_number TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS imei TEXT;
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS iccid TEXT;

-- IMEI uniquely identifies a device — index it so duplicate-device checks
-- (and lookups) stay fast.
CREATE INDEX IF NOT EXISTS idx_scan_logs_imei ON scan_logs(imei) WHERE imei IS NOT NULL;
