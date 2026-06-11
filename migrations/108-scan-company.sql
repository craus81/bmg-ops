-- Migration 101: Company attribution on scan logs
--
-- Every scan already records the user (scanned_by). This adds the external
-- company the scanner belongs to — the CNI installer's company_name. It's null
-- for internal BMG scans (admin / field installers), who have no external
-- company. Populated server-side at log time from the signed-in account.
ALTER TABLE scan_logs ADD COLUMN IF NOT EXISTS scanned_by_company TEXT;
