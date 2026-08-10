-- Migration 191: race-proof exact-duplicate guards on scan_logs
-- (docs/cni-redesign.md §3.2, Phase 3)
--
-- logScan() already blocks duplicates app-side: same vehicle (VIN last-8
-- comparison) + part, and duplicate IMEIs. But the app-level check has a race
-- window — two concurrent scans of the same vehicle both pass the read and
-- both insert. These partial unique indexes close it at the DB for EXACT
-- repeats, which are always wrong ("identical re-inserts are never right").
-- The last-8 near-duplicate check stays app-level and soft — it must remain
-- overridable by admins (two real VINs can share a last-8), which a unique
-- constraint can't express.
--
-- Dated WHERE clause: historical rows may legitimately contain exact dups
-- from before the app-level guard existed, and a failing CREATE UNIQUE INDEX
-- would break the deploy. Guarding new rows only preserves history and still
-- closes the race for everything scanned from here on.

CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_logs_vin_part_new
  ON scan_logs (vin, part_number)
  WHERE part_number IS NOT NULL AND scanned_at >= '2026-08-11';

CREATE UNIQUE INDEX IF NOT EXISTS uq_scan_logs_imei_new
  ON scan_logs (imei)
  WHERE imei IS NOT NULL AND scanned_at >= '2026-08-11';
