-- Migration 436: FleetSuite's own books, part 28 — shared bills, the second
-- piece: Snap a bill.
--
-- Owner decision 2026-10-25 (thread "Replacing NetSuite with FleetSuite",
-- "Snap a bill", as Books Previews drew it): in Books → Snap a bill a super
-- admin takes a picture of a vendor's bill, or picks its PDF. FleetSuite reads
-- it (src/lib/books/bill-reader.ts), matches the vendor to NetSuite's, works
-- out the due date from their terms, suggests each line's account from where
-- their earlier bills went, and asks NetSuite whether it already has the bill
-- (src/lib/books/snap-a-bill.ts). Once each box is checked, Send to NetSuite
-- enters it for BMG or 1084 (/api/admin/books/snap-a-bill), once only
-- (src/lib/bill-once.ts), and Books keeps its own copy of what was sent, as it
-- does for the other bills FleetSuite makes (migration 435):
--   * gl_snapped_bills, each snapped bill from its picture to NetSuite: where
--     the picture is kept (storage prefix books-bills, which /api/storage
--     never serves; only the super admins' route does), what FleetSuite read
--     from it, the form as last saved, and once sent NetSuite's bill.
--     bill_claimed_at is the claim a try at Send takes. A bill thrown away is
--     kept, marked so, with its picture;
--   * gl_own_bills.made_from takes 'snapped', and gl_own_bill_pairs says who
--     made each copy, for Own bills' "Snapped by";
--   * gl_vendor_bill_history(vendor, number, limit), what the copies hold
--     about a vendor's earlier bills: each expense line's account, memo and
--     amount, the companies and locations the copy of the general ledger
--     books each to, and any bill of theirs with the same number.
--
-- Writer and reader of the gl_ tables and functions: the service role only.
-- RLS is on with no policies, and anon/authenticated have no table or
-- function privileges.

-- ── Snapped bills ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_snapped_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The picture or PDF, at books-bills/<file_path> in storage.
  file_path TEXT NOT NULL UNIQUE CHECK (file_path ~ '^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$'),
  file_type TEXT NOT NULL CHECK (file_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  file_name TEXT,
  -- What FleetSuite read from it, as read; null until it has been read.
  read_result JSONB CHECK (read_result IS NULL OR jsonb_typeof(read_result) = 'object'),
  read_at TIMESTAMPTZ,
  read_error TEXT,
  -- The form as last saved.
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  bill_number TEXT,
  bill_date DATE,
  due_date DATE,
  total NUMERIC(14,2),
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  -- [{ description, amount, account_netsuite_id, picked }]: picked is true once someone chose the account.
  lines JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(lines) = 'array'),
  due_picked BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'thrown_away')),
  bill_claimed_at TIMESTAMPTZ,
  -- NetSuite's answer to the last try at Send that it refused.
  send_error TEXT,
  netsuite_id TEXT UNIQUE CHECK (netsuite_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  sent_at TIMESTAMPTZ,
  sent_by UUID,
  thrown_away_at TIMESTAMPTZ,
  thrown_away_by UUID,
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  saved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((status = 'sent') = (netsuite_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK ((status = 'thrown_away') = (thrown_away_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_gl_snapped_bills_status ON gl_snapped_bills(status, made_at DESC);

-- ── Own bills: snapped ones too ────────────────────────────────────────────

ALTER TABLE gl_own_bills DROP CONSTRAINT IF EXISTS gl_own_bills_made_from_check;
ALTER TABLE gl_own_bills ADD CONSTRAINT gl_own_bills_made_from_check
  CHECK (made_from IN ('vendor_invoice', 'payout', 'parts_mail', 'snapped'));

-- ── A vendor's earlier bills ───────────────────────────────────────────────

-- What the copies hold about one vendor's bills, for Snap a bill:
--   bills:       their bills NetSuite still has, voided ones left out, newest
--                first, at most p_limit: number, date and total; lines, each
--                expense line's account, memo and amount as copied (tax lines
--                and item lines left out); lines_known, false while the copy
--                couldn't read them; and the companies and locations the copy
--                of the general ledger books it to (empty before that copy
--                has it);
--   same_number: every bill of theirs whatever its date, voided ones left
--                out, whose number is p_number's letters and digits, in
--                capitals: number, date and total.
CREATE OR REPLACE FUNCTION public.gl_vendor_bill_history(p_vendor TEXT, p_number TEXT DEFAULT NULL, p_limit INTEGER DEFAULT 24)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH theirs AS (
    SELECT b.*
    FROM public.gl_netsuite_bills b
    WHERE b.vendor_netsuite_id = p_vendor
      AND b.tran_type = 'VendBill'
      AND NOT b.voided
      AND b.gone_at IS NULL
  ),
  latest AS (
    SELECT * FROM theirs ORDER BY trandate DESC, netsuite_id::bigint DESC LIMIT greatest(coalesce(p_limit, 24), 1)
  )
  SELECT jsonb_build_object(
    'bills', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', b.netsuite_id,
        'number', b.tranid,
        'date', to_char(b.trandate, 'YYYY-MM-DD'),
        'total', b.total::text,
        'lines', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'account', l.line->>'account', 'memo', l.line->>'memo', 'amount', l.line->>'amount'
          ) ORDER BY l.n), '[]'::jsonb)
          FROM jsonb_array_elements(coalesce(b.lines, '[]'::jsonb)) WITH ORDINALITY AS l(line, n)
          WHERE jsonb_typeof(l.line) = 'object'
            AND l.line->>'item' IS NULL
            AND l.line->>'account' IS NOT NULL
            AND l.line->>'tax' IS DISTINCT FROM 'true'
        ),
        'lines_known', b.lines IS NOT NULL,
        'companies', (
          SELECT coalesce(jsonb_agg(DISTINCT c.code ORDER BY c.code), '[]'::jsonb)
          FROM public.gl_netsuite_lines g
          JOIN public.gl_companies c ON c.id = g.company_id
          WHERE g.transaction_id = b.netsuite_id
        ),
        'locations', (
          SELECT coalesce(jsonb_agg(DISTINCT g.location_id ORDER BY g.location_id), '[]'::jsonb)
          FROM public.gl_netsuite_lines g
          WHERE g.transaction_id = b.netsuite_id
            AND g.location_id IS NOT NULL
        )
      ) ORDER BY b.trandate DESC, b.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM latest b
    ),
    'same_number', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', b.netsuite_id,
        'number', b.tranid,
        'date', to_char(b.trandate, 'YYYY-MM-DD'),
        'total', b.total::text
      ) ORDER BY b.trandate DESC, b.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM theirs b
      WHERE upper(regexp_replace(coalesce(p_number, ''), '[^A-Za-z0-9]', '', 'g')) <> ''
        AND upper(regexp_replace(coalesce(b.tranid, ''), '[^A-Za-z0-9]', '', 'g'))
          = upper(regexp_replace(p_number, '[^A-Za-z0-9]', '', 'g'))
    )
  )
$$;

-- ── Own bill pairs: who made each copy ─────────────────────────────────────

-- Migration 435's gl_own_bill_pairs, with made_by on each copy.
CREATE OR REPLACE FUNCTION public.gl_own_bill_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*, c.code AS company
    FROM public.gl_own_bills o
    JOIN public.gl_companies c ON c.id = o.company_id
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.bill_date BETWEEN p_from AND p_to END
  ),
  twin AS (
    SELECT b.*
    FROM public.gl_netsuite_bills b
    WHERE b.netsuite_id IN (SELECT netsuite_id FROM own)
  )
  SELECT jsonb_build_object(
    'bills', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'company', o.company,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'vendor_id', o.vendor_netsuite_id,
          'vendor_name', o.vendor_name,
          'reference_no', o.reference_no,
          'date', to_char(o.bill_date, 'YYYY-MM-DD'),
          'po_id', o.po_netsuite_id,
          'po_number', o.po_number,
          'location_id', o.location_netsuite_id,
          'invoice_total', o.invoice_total::text,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'made_by', o.made_by,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'account_id', l.account_netsuite_id,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'quantity', l.quantity::text,
              'rate', l.rate::text,
              'amount', l.amount::text,
              'po_line_id', l.po_line_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_bill_lines l
            WHERE l.bill_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.tranid,
            'type', t.tran_type,
            'date', to_char(t.trandate, 'YYYY-MM-DD'),
            'vendor_id', t.vendor_netsuite_id,
            'vendor_name', t.vendor_name,
            'total', t.total::text,
            'status', t.status_label,
            'voided', t.voided,
            'gone', t.gone_at IS NOT NULL,
            'lines', t.lines,
            'links', t.links,
            'companies', (
              SELECT coalesce(jsonb_agg(DISTINCT gc.code ORDER BY gc.code), '[]'::jsonb)
              FROM public.gl_netsuite_lines gl
              JOIN public.gl_companies gc ON gc.id = gl.company_id
              WHERE gl.transaction_id = t.netsuite_id
            )
          )
          FROM twin t
          WHERE t.netsuite_id = o.netsuite_id
        )
      ) ORDER BY o.bill_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'accounts', (
      SELECT coalesce(jsonb_object_agg(a.netsuite_account_id, jsonb_build_object('number', a.number, 'name', a.name)), '{}'::jsonb)
      FROM public.gl_accounts a
      WHERE a.netsuite_account_id IN (
        SELECT l.account_netsuite_id FROM public.gl_own_bill_lines l JOIN own o ON o.netsuite_id = l.bill_id
        UNION
        SELECT x.line->>'account' FROM twin t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.lines, '[]'::jsonb)) AS x(line)
        WHERE jsonb_typeof(x.line) = 'object'
      )
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(i.netsuite_id, jsonb_build_object(
        'number', i.name, 'type', i.details->>'item_type', 'display_name', i.details->>'display_name'
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (
        SELECT l.item_netsuite_id FROM public.gl_own_bill_lines l JOIN own o ON o.netsuite_id = l.bill_id
        UNION
        SELECT x.line->>'item' FROM twin t CROSS JOIN LATERAL jsonb_array_elements(coalesce(t.lines, '[]'::jsonb)) AS x(line)
        WHERE jsonb_typeof(x.line) = 'object'
      )
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_snapped_bills ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_snapped_bills FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_vendor_bill_history(text, text, integer)',
    'public.gl_own_bill_pairs(date, date, text)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE gl_snapped_bills IS 'Migration 436: each bill snapped in Books → Snap a bill, from its picture (storage prefix books-bills, served only to super admins) to NetSuite: what FleetSuite read from it, the form as last saved, and once sent NetSuite''s bill (src/lib/books/snap-a-bill.ts). bill_claimed_at is the claim a try at Send takes (src/lib/bill-once.ts). Service-role write and read.';
COMMENT ON COLUMN gl_own_bills.made_from IS 'Migration 435/436: where FleetSuite made the bill: vendor_invoice, payout, parts_mail or snapped (Snap a bill).';
COMMENT ON FUNCTION public.gl_vendor_bill_history(text, text, integer) IS 'Migration 436: what the copies hold about one vendor''s bills, for Snap a bill''s suggestions and its check for the same bill: their latest bills with each expense line''s account, memo and amount and the companies and locations the copy of the general ledger books them to, and any bill of theirs with the same number. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_pairs(date, date, text) IS 'Migration 435/436: Books'' own bills made on some days, or one, each next to NetSuite''s bill as the copy of its bills has it, with the companies the copy of its general ledger books it to and who made the copy, for the Own bills page and the daily check. Service role only.';
