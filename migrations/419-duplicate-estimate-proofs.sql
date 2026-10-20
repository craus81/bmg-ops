-- Duplicated estimates keep their proofs (Craig, 2026-10-20).
--
-- 1. estimates.copied_graphics_proofs: the art proof a duplicate shows from
--    the original's graphics job, [{job_id, file_ids, from_estimate}]
--    (src/lib/estimate-copied-proofs.ts). The job stays with the original.
-- 2. Old duplicates get their own Graphics Builder worksheet.
-- 3. Old duplicates show the original job's chosen art proof.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS copied_graphics_proofs JSONB;

-- Duplicated estimates get their own Graphics Builder worksheet (Craig,
-- 2026-10-20). Before this, Duplicate copied the graphics lines (with their
-- wrap_quote_id) but left the worksheet pinned to the original, so the copy
-- showed no coverage proof and its lines pointed at the original's
-- worksheet. src/lib/estimate-copy-worksheets.ts now copies the worksheet on
-- every Duplicate; this fixes the duplicates made before it.
--
-- For each open estimate whose graphics lines point at a worksheet pinned
-- to a DIFFERENT estimate, outside its fleet order (fleet copies share the
-- worksheet on purpose): copy the worksheet as a new draft pinned to the
-- estimate, then point that estimate's lines at the copy. Approved,
-- accepted and Sales Order estimates are left as they are. The original
-- worksheet is never changed. Proof pictures are shared by storage path,
-- exactly as the app does. Re-running finds nothing left to fix.

DO $$
DECLARE
  r RECORD;
  src JSONB;
  new_id UUID;
  new_number TEXT;
  cols TEXT;
BEGIN
  FOR r IN
    SELECT DISTINCT li.estimate_id AS estimate_id, w.id AS worksheet_id
    FROM estimate_line_items li
    JOIN wrap_quotes w ON w.id = li.wrap_quote_id
    JOIN estimates e ON e.id = li.estimate_id
    JOIN estimates home ON home.id = w.estimate_id
    WHERE w.estimate_id <> li.estimate_id
      AND NOT (e.fleet_group_id IS NOT NULL AND e.fleet_group_id IS NOT DISTINCT FROM home.fleet_group_id)
      AND NOT COALESCE(e.customer_approved, false)
      AND COALESCE(e.status, '') <> 'accepted'
      AND e.netsuite_so_id IS NULL
    ORDER BY li.estimate_id, w.id
  LOOP
    new_id := gen_random_uuid();
    new_number := public.next_job_number('WQ');

    -- Same rules as worksheetCopyRow: identity and lifecycle columns
    -- (approval, NetSuite, signed documents, follow-up, expiry) start fresh.
    SELECT jsonb_object_agg(kv.key, kv.value) INTO src
    FROM wrap_quotes w, jsonb_each(to_jsonb(w)) kv
    WHERE w.id = r.worksheet_id
      AND kv.key NOT IN ('id', 'quote_number', 'estimate_id', 'status', 'sent_at', 'sent_to', 'accepted_at',
                         'rejected_at', 'archived_at', 'created_at', 'updated_at', 'updated_by',
                         'never_opened_notified_at')
      AND kv.key !~ '^(netsuite_|approval_|customer_approved|customer_reject|signed_document_|last_followup|followup_|expiry_)';

    src := src || jsonb_build_object(
      'id', new_id,
      'quote_number', new_number,
      'estimate_id', r.estimate_id,
      'status', 'draft',
      'created_at', now(),
      'updated_at', now()
    );

    -- Only the columns carried over are named, so every dropped one takes
    -- its column default (approval_relink_count 0 and the like).
    SELECT string_agg(quote_ident(k), ', ') INTO cols FROM jsonb_object_keys(src) k;
    EXECUTE format('INSERT INTO wrap_quotes (%s) SELECT %s FROM jsonb_populate_record(NULL::wrap_quotes, $1)', cols, cols)
      USING src;

    UPDATE estimate_line_items
    SET wrap_quote_id = new_id
    WHERE estimate_id = r.estimate_id
      AND wrap_quote_id = r.worksheet_id;
  END LOOP;
END $$;

-- 3. Open copies made before this (plain duplicates from the audit log,
-- revisions from supersedes_estimate_id) with no art proof of their own:
-- show what was chosen on the original's job, or its fleet order's job when
-- the copy left the order. Old revisions only show it; the job stays put.
-- Re-running finds nothing left to fix.
WITH sources AS (
  SELECT e.id AS estimate_id, e.supersedes_estimate_id AS source_id
  FROM estimates e
  WHERE e.supersedes_estimate_id IS NOT NULL
  UNION
  SELECT e.id, (a.detail->>'source_estimate_id')::uuid
  FROM audit_log a
  JOIN estimates e ON e.id::text = a.record_id
  WHERE a.table_name = 'estimates'
    AND a.action = 'estimate_duplicated'
    AND a.detail->>'source_estimate_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
proofs AS (
  SELECT s.estimate_id,
         jsonb_agg(jsonb_build_object('job_id', j.id, 'file_ids', j.estimate_attach->'file_ids', 'from_estimate', src.estimate_number)
                   ORDER BY j.created_at) AS copied
  FROM sources s
  JOIN estimates e ON e.id = s.estimate_id
  JOIN estimates src ON src.id = s.source_id
  JOIN graphics_jobs j
    ON j.estimate_id = src.id
    OR (src.fleet_group_id IS NOT NULL AND j.fleet_group_id = src.fleet_group_id
        AND e.fleet_group_id IS DISTINCT FROM src.fleet_group_id)
  WHERE e.copied_graphics_proofs IS NULL
    AND NOT COALESCE(e.customer_approved, false)
    AND COALESCE(e.status, '') <> 'accepted'
    AND e.netsuite_so_id IS NULL
    AND jsonb_typeof(j.estimate_attach->'file_ids') = 'array'
    AND jsonb_array_length(j.estimate_attach->'file_ids') > 0
    AND NOT EXISTS (
      SELECT 1 FROM graphics_jobs own
      WHERE own.estimate_id = e.id
         OR (e.fleet_group_id IS NOT NULL AND own.fleet_group_id = e.fleet_group_id)
    )
  GROUP BY s.estimate_id
)
UPDATE estimates e
SET copied_graphics_proofs = p.copied
FROM proofs p
WHERE e.id = p.estimate_id;
