-- Migration 425: estimate pictures on the estimate and in Client Files.
--
-- Craig (2026-10-22, thread "Approval email pictures on the estimate"):
-- Valarie sent an approval email with pictures, and they were nowhere on
-- the estimate in FleetSuite. They were saved (estimate_files) but only the
-- email screens showed them. Now the estimate has a Pictures & files
-- section, every customer's Client Files has a "From Estimates" folder and a
-- "Completion Photos" folder read straight from FleetSuite, and estimate
-- files are also copied into the customer's linked Dropbox client folder.

-- Which emails each file went out on: [{ "kind": "approval"|"email_pdf"|
-- "follow_up", "at": iso }]. Appended by the send routes.
ALTER TABLE estimate_files ADD COLUMN IF NOT EXISTS sent_on JSONB NOT NULL DEFAULT '[]'::jsonb;

-- The Dropbox copy (src/lib/estimate-file-dropbox.ts). dropbox_path is the
-- file's path in Dropbox once copied; dropbox_error is the plain reason the
-- last try failed (no folder linked yet is not an error: both stay null and
-- the cron tries again once a folder is linked).
ALTER TABLE estimate_files ADD COLUMN IF NOT EXISTS dropbox_path TEXT;
ALTER TABLE estimate_files ADD COLUMN IF NOT EXISTS dropbox_copied_at TIMESTAMPTZ;
ALTER TABLE estimate_files ADD COLUMN IF NOT EXISTS dropbox_error TEXT;
ALTER TABLE estimate_files ADD COLUMN IF NOT EXISTS dropbox_tried_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_estimate_files_dropbox_pending
  ON estimate_files (created_at) WHERE dropbox_path IS NULL;

-- Approval sends since migration 424 recorded the files they carried.
-- Re-runs are harmless: only rows with nothing recorded yet are filled.
UPDATE estimate_files f
SET sent_on = sub.sent_on
FROM (
  SELECT ef.id,
         jsonb_agg(jsonb_build_object('kind', 'approval', 'at', t.created_at) ORDER BY t.created_at) AS sent_on
  FROM estimate_files ef
  JOIN estimate_download_tokens t
    ON t.estimate_id = ef.estimate_id AND ef.id = ANY (t.file_ids)
  GROUP BY ef.id
) sub
WHERE f.id = sub.id
  AND f.sent_on = '[]'::jsonb;

-- completion_photos gains customer_id (shop photos only: fleet_checkins has
-- one since migration 220). Installer and scan photos only carry a name, so
-- Client Files also matches on the name. New column goes last, as
-- CREATE OR REPLACE VIEW requires.
CREATE OR REPLACE VIEW completion_photos
AS
SELECT
  'shop:' || vp.id::text            AS id,
  'shop'::text                      AS source,
  vp.storage_path                   AS storage_path,
  COALESCE(vp.taken_at, fc.created_at) AS taken_at,
  vp.taken_by                       AS taken_by,
  fc.customer_name                  AS customer_name,
  fc.vin::text                      AS vin,
  NULLIF(concat_ws(' ', fc.vehicle_year, fc.vehicle_make, fc.vehicle_model), '') AS vehicle,
  fc.sales_order_number::text       AS job_label,
  fc.id                             AS record_id,
  fc.customer_id                    AS customer_id
FROM vehicle_photos vp
JOIN fleet_checkins fc ON fc.id = vp.vehicle_id
WHERE vp.photo_type = 'completion'

UNION ALL

SELECT
  'installer:' || p.id::text,
  'installer'::text,
  CASE WHEN p.storage_path LIKE 'photos/%' THEN substr(p.storage_path, 8) ELSE p.storage_path END,
  p.uploaded_at,
  p.uploaded_by,
  COALESCE(NULLIF(j.billable_customer, ''), j.customer_name),
  v.vin,
  NULLIF(concat_ws(' ', v.vehicle_year, v.vehicle_make, v.vehicle_model), ''),
  j.job_number,
  j.id,
  NULL::uuid
FROM cni_job_photos p
JOIN cni_jobs j ON j.id = p.job_id
LEFT JOIN cni_job_vins v ON v.id = p.vin_id
WHERE p.photo_type <> 'vin_plate'
  AND p.review_status <> 'denied'

UNION ALL

SELECT
  'scan:' || sp.id::text,
  'scan'::text,
  sp.storage_path,
  sp.created_at,
  sp.taken_by,
  s.billable_customer,
  s.vin::text,
  NULLIF(concat_ws(' ', s.vehicle_year, s.vehicle_make, s.vehicle_model), ''),
  COALESCE('PO ' || NULLIF(s.po_number, ''), s.part_number),
  s.id,
  NULL::uuid
FROM (
  SELECT DISTINCT ON (storage_path) id, scan_log_id, storage_path, created_at, taken_by
  FROM scan_photos
  ORDER BY storage_path, created_at, id
) sp
JOIN scan_logs s ON s.id = sp.scan_log_id;

REVOKE ALL ON completion_photos FROM anon, authenticated;
