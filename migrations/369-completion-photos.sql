-- Completion Photos: every finished-work photo across jobs, in one place.
--
-- Finished-work photos live in three tables, one job at a time:
--   vehicle_photos (photo_type 'completion') on in-shop check-ins,
--   cni_job_photos from outside installers, and
--   scan_photos (K8) taken when a part install is scanned.
-- Staff wanted one place to browse them by customer and job and grab some
-- to send a customer. The view below unions the three into one shape so
-- /api/completion-photos can filter and page them with one ordered query.
--
-- CNI VIN-plate shots and photos a reviewer denied are left out: neither is
-- something you would send a customer. A scan photo of a multi-part scan is
-- stored once per part row (same storage_path), so it is collapsed to one.
--
-- storage_path is normalised to be relative to the 'photos' prefix (some
-- older CNI rows carry the full 'photos/…' key).

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
  fc.id                             AS record_id
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
  j.id
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
  s.id
FROM (
  SELECT DISTINCT ON (storage_path) id, scan_log_id, storage_path, created_at, taken_by
  FROM scan_photos
  ORDER BY storage_path, created_at, id
) sp
JOIN scan_logs s ON s.id = sp.scan_log_id;

-- Read only through the staff-gated API route (service role). Nothing in
-- the browser queries it, and anon must never see it.
REVOKE ALL ON completion_photos FROM anon, authenticated;

-- A shared set of photos for one customer: the link's token is the only
-- credential, as with estimate approval links. photo_ids hold
-- completion_photos ids ('shop:<uuid>' …) picked at share time, so a photo
-- added later never appears on a link the customer already has.
CREATE TABLE IF NOT EXISTS photo_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token text NOT NULL UNIQUE,
  photo_ids text[] NOT NULL,
  title text,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days'
);

ALTER TABLE photo_shares ENABLE ROW LEVEL SECURITY;
-- No policies: only the service-role API routes read or write it.
REVOKE ALL ON photo_shares FROM anon, authenticated;
