-- Migration 384: FleetSuite's own books, part 11 — vendor bills and bill
-- credits, copied from NetSuite and checked against its GL.
--
-- Owner decision 2026-10-16 (thread "Replacing NetSuite with FleetSuite"):
-- vendor bills are the next piece after customer deposits, copied and checked
-- against NetSuite first, posted once they match. NetSuite keeps two
-- documents for what BMG owes its vendors: the bill (VendBill), and the bill
-- credit (VendCred), which takes some of it back. Both are copied every two
-- hours with their lines (src/lib/books/netsuite-bills.ts, from
-- /api/cron/books-netsuite-bills at :39 on odd hours and "Copy now" on the
-- invoices page's Bills switch), and each is checked against the GL lines
-- NetSuite posted for it with the bill rule, bill@1
-- (src/lib/books/bill-rule.ts, src/lib/books/bill-check.ts).
--
-- The ledger mirror's ledger_bills (migration 314) is not where they go: it
-- holds QuickBooks' bills, and the mirror's delete sweep takes the NetSuite
-- rows of its tables for its own documents. So the copy is a books table of
-- its own, like the customer deposits (migration 382): it follows NetSuite
-- until the changeover, nothing is written back, and a row is never deleted.
-- gone_at records when NetSuite stopped listing it, and it comes back if
-- NetSuite lists it again.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_bills (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (tran_type IN ('VendBill', 'VendCred')),
  tranid TEXT,
  trandate DATE NOT NULL,
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  status TEXT,
  status_label TEXT,
  voided BOOLEAN NOT NULL DEFAULT false,
  memo TEXT,
  lines JSONB CHECK (lines IS NULL OR jsonb_typeof(lines) = 'array'),
  links JSONB CHECK (links IS NULL OR jsonb_typeof(links) = 'array'),
  gone_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_bills_date ON gl_netsuite_bills(trandate);

-- Applies one page of NetSuite bills and bill credits. p:
--   { rows: [{ netsuite_id, tran_type, tranid?, trandate, vendor_netsuite_id?, vendor_name?,
--              total, status?, status_label?, voided?, memo?, lines?, links? }] }
-- lines, when given, are the document's lines as NetSuite has them:
-- [{ line_id, item, account, amount, quantity, memo, tax }], amounts signed
-- as NetSuite gives them. links, when given, are the documents it came from:
-- [{ netsuite_id, type, number, amount, link_type }]. A row without lines or
-- links keeps the ones it has, so a run that couldn't read them changes
-- nothing there. A new row is added. A row whose content differs is updated,
-- and one that had gone from NetSuite is back. The whole page applies or none
-- of it does. Returns { received, added, changed }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_bills_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bad TEXT;
  v_added INTEGER;
  v_changed INTEGER;
BEGIN
  IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: rows must be a list';
  END IF;
  -- One writer at a time: the cron and "Copy now" can land together.
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_bills'));

  SELECT coalesce(x.v->>'netsuite_id', '(none)') INTO v_bad
  FROM jsonb_array_elements(p->'rows') AS x(v)
  WHERE coalesce(x.v->>'netsuite_id', '') !~ '^[0-9]+$'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite id "%" isn''t a number', v_bad;
  END IF;
  SELECT x.v->>'netsuite_id' INTO v_bad
  FROM jsonb_array_elements(p->'rows') AS x(v)
  GROUP BY x.v->>'netsuite_id'
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % is in the page twice', v_bad;
  END IF;
  SELECT x.v->>'netsuite_id' INTO v_bad
  FROM jsonb_array_elements(p->'rows') AS x(v)
  WHERE coalesce(x.v->>'tran_type', '') NOT IN ('VendBill', 'VendCred')
     OR nullif(x.v->>'trandate', '') IS NULL
     OR nullif(x.v->>'total', '') IS NULL
     OR (x.v ? 'lines' AND jsonb_typeof(x.v->'lines') IS DISTINCT FROM 'array')
     OR (x.v ? 'links' AND jsonb_typeof(x.v->'links') IS DISTINCT FROM 'array')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % isn''t a bill or bill credit with a date and total', v_bad;
  END IF;
  -- Every line carries NetSuite's line id; the lists are known to be lists by now.
  SELECT x.v->>'netsuite_id' INTO v_bad
  FROM jsonb_array_elements(p->'rows') AS x(v)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN x.v ? 'lines' THEN x.v->'lines' ELSE '[]'::jsonb END) AS l(line)
  WHERE jsonb_typeof(l.line) IS DISTINCT FROM 'object' OR coalesce(l.line->>'line_id', '') !~ '^[0-9]+$'
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % has a line without a line id', v_bad;
  END IF;

  WITH incoming AS (
    SELECT x.v->>'netsuite_id' AS netsuite_id,
           x.v->>'tran_type' AS tran_type,
           nullif(btrim(x.v->>'tranid'), '') AS tranid,
           (x.v->>'trandate')::date AS trandate,
           nullif(x.v->>'vendor_netsuite_id', '') AS vendor_netsuite_id,
           nullif(btrim(x.v->>'vendor_name'), '') AS vendor_name,
           (x.v->>'total')::numeric(16,2) AS total,
           nullif(x.v->>'status', '') AS status,
           nullif(x.v->>'status_label', '') AS status_label,
           coalesce((x.v->>'voided')::boolean, false) AS voided,
           nullif(x.v->>'memo', '') AS memo,
           CASE WHEN x.v ? 'lines' THEN x.v->'lines' END AS lines,
           CASE WHEN x.v ? 'links' THEN x.v->'links' END AS links
    FROM jsonb_array_elements(p->'rows') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_bills AS d (
      netsuite_id, tran_type, tranid, trandate, vendor_netsuite_id, vendor_name,
      total, status, status_label, voided, memo, lines, links
    )
    SELECT i.netsuite_id, i.tran_type, i.tranid, i.trandate, i.vendor_netsuite_id, i.vendor_name,
           i.total, i.status, i.status_label, i.voided, i.memo, i.lines, i.links
    FROM incoming i
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tran_type = EXCLUDED.tran_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      vendor_netsuite_id = EXCLUDED.vendor_netsuite_id,
      vendor_name = EXCLUDED.vendor_name,
      total = EXCLUDED.total,
      status = EXCLUDED.status,
      status_label = EXCLUDED.status_label,
      voided = EXCLUDED.voided,
      memo = EXCLUDED.memo,
      lines = coalesce(EXCLUDED.lines, d.lines),
      links = coalesce(EXCLUDED.links, d.links),
      gone_at = NULL,
      changed_at = now()
    WHERE (d.tran_type, d.tranid, d.trandate, d.vendor_netsuite_id, d.vendor_name, d.total,
           d.status, d.status_label, d.voided, d.memo, d.lines, d.links, d.gone_at)
      IS DISTINCT FROM (EXCLUDED.tran_type, EXCLUDED.tranid, EXCLUDED.trandate, EXCLUDED.vendor_netsuite_id,
           EXCLUDED.vendor_name, EXCLUDED.total, EXCLUDED.status, EXCLUDED.status_label, EXCLUDED.voided,
           EXCLUDED.memo, coalesce(EXCLUDED.lines, d.lines), coalesce(EXCLUDED.links, d.links), NULL::timestamptz)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  RETURN jsonb_build_object('received', jsonb_array_length(p->'rows'), 'added', v_added, 'changed', v_changed);
END;
$$;

-- Once a run has read every bill and bill credit id NetSuite has, marks the
-- rows NetSuite no longer lists as gone. A read that looks cut short (none,
-- or under half of the rows still here) marks nothing and says so. p:
--   { netsuite_ids: [every id NetSuite listed] }
-- Returns { listed, here, gone, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_bills_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_listed INTEGER;
  v_here INTEGER;
  v_gone INTEGER := 0;
BEGIN
  IF jsonb_typeof(p->'netsuite_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: netsuite_ids must be a list';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_bills'));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_bills WHERE gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_bills d SET gone_at = now()
  WHERE d.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = d.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- One company's NetSuite bills and bill credits for one month: those NetSuite
-- booked into it (gl_netsuite_transactions.posting_month), and those dated in
-- it that the copy of NetSuite's GL has booked into no month, as invoices are
-- read since migration 380. Each comes with its lines and links from the copy
-- (null until a run could read them), its vendor's name and payables account
-- from the vendors copy (migration 363), and the GL lines NetSuite posted for
-- it (migration 361). A document is a
-- company's when NetSuite posted a GL line of it to that company; one with no
-- GL line in the copy comes back for every company. Also:
--   items:            the copied items the lines name, with their type and
--                     asset, expense and income accounts
--   receipt_accounts: the accounts the company's item receipts credit across
--                     the whole GL copy, by how many receipts use each: what
--                     NetSuite holds received stock against until it's billed
--   not_copied:       bills and bill credits the GL copy has booked into the
--                     month that the copy of the documents doesn't (yet)
CREATE OR REPLACE FUNCTION public.gl_bill_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH bounds AS (
    SELECT date_trunc('month', p_month)::date AS m_from,
           (date_trunc('month', p_month) + interval '1 month')::date AS m_to
  ),
  month_docs AS (
    -- Dated in the month, unless NetSuite booked it into another one.
    SELECT b.netsuite_id, b.tran_type, b.tranid, b.trandate, b.vendor_netsuite_id, b.vendor_name, b.total,
           b.status_label, b.voided, b.lines, b.links, t.posting_month
    FROM public.gl_netsuite_bills b
    CROSS JOIN bounds m
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = b.netsuite_id
    WHERE b.gone_at IS NULL
      AND b.trandate >= m.m_from
      AND b.trandate < m.m_to
      AND (t.posting_month IS NULL OR t.posting_month = m.m_from)
    UNION ALL
    -- Dated in another month, but booked by NetSuite into this one.
    SELECT b.netsuite_id, b.tran_type, b.tranid, b.trandate, b.vendor_netsuite_id, b.vendor_name, b.total,
           b.status_label, b.voided, b.lines, b.links, t.posting_month
    FROM public.gl_netsuite_transactions t
    CROSS JOIN bounds m
    JOIN public.gl_netsuite_bills b ON b.netsuite_id = t.netsuite_id
    WHERE t.posting_month = m.m_from
      AND b.gone_at IS NULL
      AND (b.trandate < m.m_from OR b.trandate >= m.m_to)
  ),
  posted AS (
    SELECT m.netsuite_id, array_agg(DISTINCT c.code ORDER BY c.code) AS companies
    FROM month_docs m
    JOIN public.gl_netsuite_lines l ON l.transaction_id = m.netsuite_id
    JOIN public.gl_companies c ON c.id = l.company_id
    GROUP BY m.netsuite_id
  ),
  picked AS (
    SELECT m.*, coalesce(p.companies, ARRAY[]::text[]) AS companies
    FROM month_docs m
    LEFT JOIN posted p ON p.netsuite_id = m.netsuite_id
    WHERE p.companies IS NULL OR p_company IS NULL OR p_company = ANY (p.companies)
  )
  SELECT jsonb_build_object(
    'bills', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', x.netsuite_id,
        'type', x.tran_type,
        'number', x.tranid,
        'date', to_char(x.trandate, 'YYYY-MM-DD'),
        'posting_month', to_char(x.posting_month, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'status', x.status_label,
        'vendor', coalesce(v.name, x.vendor_name),
        'vendor_netsuite_id', x.vendor_netsuite_id,
        'vendor_payables', v.details->>'payables_account',
        'companies', to_jsonb(x.companies),
        'lines', x.lines,
        'links', x.links,
        'netsuite', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', l.line_id,
            'account', l.netsuite_account_id,
            'debit', l.debit::text,
            'credit', l.credit::text
          ) ORDER BY l.line_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_lines l
          WHERE l.transaction_id = x.netsuite_id
        )
      ) ORDER BY x.trandate, x.tranid, x.netsuite_id::bigint), '[]'::jsonb)
      FROM picked x
      LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.vendor_netsuite_id
    ),
    'items', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', li.netsuite_id,
        'name', li.name,
        'active', li.active,
        'gone', li.gone_at IS NOT NULL,
        'item_type', li.details->>'item_type',
        'asset_account', li.details->>'asset_account',
        'expense_account', li.details->>'expense_account',
        'income_account', li.details->>'income_account'
      ) ORDER BY li.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_lists li
      WHERE li.kind = 'item'
        AND li.netsuite_id IN (
          SELECT l.line->>'item'
          FROM picked x
          CROSS JOIN LATERAL jsonb_array_elements(coalesce(x.lines, '[]'::jsonb)) AS l(line)
          WHERE l.line->>'item' IS NOT NULL
        )
    ),
    'receipt_accounts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('account', u.account, 'documents', u.documents)
                                ORDER BY u.documents DESC, u.account), '[]'::jsonb)
      FROM (
        SELECT l.netsuite_account_id AS account, count(DISTINCT l.transaction_id) AS documents
        FROM public.gl_netsuite_transactions t
        JOIN public.gl_netsuite_lines l ON l.transaction_id = t.netsuite_id
        JOIN public.gl_companies c ON c.id = l.company_id
        WHERE t.tran_type = 'ItemRcpt'
          AND (p_company IS NULL OR c.code = p_company)
          AND l.credit > l.debit
        GROUP BY l.netsuite_account_id
      ) u
    ),
    'not_copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', t.netsuite_id, 'type', t.tran_type, 'number', t.tranid)
                                ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_transactions t
      CROSS JOIN bounds m
      WHERE t.tran_type IN ('VendBill', 'VendCred')
        AND t.posting_month = m.m_from
        AND (p_company IS NULL OR EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l JOIN public.gl_companies c ON c.id = l.company_id
          WHERE l.transaction_id = t.netsuite_id AND c.code = p_company
        ))
        AND NOT EXISTS (
          SELECT 1 FROM public.gl_netsuite_bills b WHERE b.netsuite_id = t.netsuite_id AND b.gone_at IS NULL
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
  ALTER TABLE gl_netsuite_bills ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_bills FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_bills_apply(jsonb)',
    'public.gl_netsuite_bills_finish(jsonb)',
    'public.gl_bill_month(text, date)'
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

COMMENT ON TABLE gl_netsuite_bills IS 'Migration 384: NetSuite''s vendor bills (VendBill) and bill credits (VendCred) with their lines, copied every two hours by src/lib/books/netsuite-bills.ts for the bill rule''s check. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_bills.tran_type IS 'VendBill: what BMG owes a vendor. VendCred: a bill credit, which takes some of it back.';
COMMENT ON COLUMN gl_netsuite_bills.total IS 'The document''s total as NetSuite gives it (foreigntotal, in the document''s currency), kept positive.';
COMMENT ON COLUMN gl_netsuite_bills.voided IS 'NetSuite''s status for it reads Voided.';
COMMENT ON COLUMN gl_netsuite_bills.lines IS 'Its lines but the payables line, from NetSuite''s transaction lines: [{line_id, item, account, amount, quantity, memo, tax}]. item is the item''s NetSuite id (null on an expense line), account the line''s expense account when NetSuite gives one, amount its net amount signed as NetSuite gives it. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_bills.links IS 'The documents it came from, from NetSuite''s transaction link table (its previous documents): a bill''s purchase orders and item receipts. [{netsuite_id, type, number, amount, link_type}], amounts positive. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_bills.gone_at IS 'When a whole read of NetSuite''s bill ids no longer had it. NULL = still in NetSuite.';
COMMENT ON COLUMN gl_netsuite_bills.changed_at IS 'When the copy last changed: added, or anything NetSuite holds for it changed.';
COMMENT ON FUNCTION public.gl_bill_month(text, date) IS 'Migration 384: one company''s NetSuite bills and bill credits for one month (those NetSuite booked into it, and those dated in it that the copy of NetSuite''s GL has booked into no month), each with its lines, links, vendor''s payables account and the GL lines NetSuite posted for it (migration 361), plus the copied items the lines name, the accounts the company''s item receipts credit and the GL copy''s documents not copied yet, for the bill rule''s check. Service role only.';
