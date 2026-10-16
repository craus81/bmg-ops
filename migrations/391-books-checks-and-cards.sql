-- Migration 391: FleetSuite's own books, part 12 — checks and credit card
-- charges and refunds, copied from NetSuite and checked against its GL.
--
-- Owner decision 2026-10-16 (thread "Replacing NetSuite with FleetSuite",
-- "Checks and cards"): after bill payments, the money BMG spends straight
-- from the bank or on its Chase card comes next, copied and checked against
-- NetSuite first, posted only after a preview and the owner's OK. NetSuite
-- keeps three documents for it: the check (Check), money paid from a bank
-- account; the credit card charge (CardChrg), a purchase on a card; and the
-- credit card refund (CardRfnd), money a vendor puts back on the card. Each
-- has lines like a bill's, expense lines and items, but no payables: the
-- money comes straight out of the account the document names. They are
-- copied every two hours with their lines (src/lib/books/netsuite-spending.ts,
-- from /api/cron/books-netsuite-spending at :33 on odd hours and "Copy now"
-- on the invoices page's Checks and cards switch), and each is checked
-- against the GL lines NetSuite posted for it with the spending rule,
-- spending@1 (src/lib/books/spending-rule.ts, src/lib/books/spending-check.ts).
--
-- The ledger mirror's ledger_bills (migration 314) has slots for checks and
-- card charges, but it holds QuickBooks' documents, and the mirror's delete
-- sweep takes the NetSuite rows of its tables for its own documents. So the
-- copy is a books table of its own, like the bills (migration 384): it
-- follows NetSuite until the changeover, nothing is written back, and a row
-- is never deleted. gone_at records when NetSuite stopped listing it, and it
-- comes back if NetSuite lists it again. Nothing posts to the journal yet.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_spending (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (tran_type IN ('Check', 'CardChrg', 'CardRfnd')),
  tranid TEXT,
  trandate DATE NOT NULL,
  payee_netsuite_id TEXT CHECK (payee_netsuite_id ~ '^[0-9]+$'),
  payee_name TEXT,
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  status TEXT,
  status_label TEXT,
  voided BOOLEAN NOT NULL DEFAULT false,
  memo TEXT,
  lines JSONB CHECK (lines IS NULL OR jsonb_typeof(lines) = 'array'),
  gone_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_spending_date ON gl_netsuite_spending(trandate);

-- Applies one page of NetSuite checks and card charges and refunds. p:
--   { rows: [{ netsuite_id, tran_type, tranid?, trandate, payee_netsuite_id?, payee_name?,
--              total, status?, status_label?, voided?, memo?, lines? }] }
-- lines, when given, are the document's lines as NetSuite has them, all but
-- the line for the account the money comes out of: [{ line_id, item,
-- account, amount, own_amount, quantity, memo, tax }], amounts signed as
-- NetSuite gives them. A row without lines keeps the ones it has, so a run
-- that couldn't read them changes nothing there. A new row is added. A row
-- whose content differs is updated, and one that had gone from NetSuite is
-- back. The whole page applies or none of it does. Returns
-- { received, added, changed }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_spending_apply(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_spending'));

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
  WHERE coalesce(x.v->>'tran_type', '') NOT IN ('Check', 'CardChrg', 'CardRfnd')
     OR nullif(x.v->>'trandate', '') IS NULL
     OR nullif(x.v->>'total', '') IS NULL
     OR (x.v ? 'lines' AND jsonb_typeof(x.v->'lines') IS DISTINCT FROM 'array')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % isn''t a check, card charge or card refund with a date and total', v_bad;
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
           nullif(x.v->>'payee_netsuite_id', '') AS payee_netsuite_id,
           nullif(btrim(x.v->>'payee_name'), '') AS payee_name,
           (x.v->>'total')::numeric(16,2) AS total,
           nullif(x.v->>'status', '') AS status,
           nullif(x.v->>'status_label', '') AS status_label,
           coalesce((x.v->>'voided')::boolean, false) AS voided,
           nullif(x.v->>'memo', '') AS memo,
           CASE WHEN x.v ? 'lines' THEN x.v->'lines' END AS lines
    FROM jsonb_array_elements(p->'rows') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_spending AS d (
      netsuite_id, tran_type, tranid, trandate, payee_netsuite_id, payee_name,
      total, status, status_label, voided, memo, lines
    )
    SELECT i.netsuite_id, i.tran_type, i.tranid, i.trandate, i.payee_netsuite_id, i.payee_name,
           i.total, i.status, i.status_label, i.voided, i.memo, i.lines
    FROM incoming i
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tran_type = EXCLUDED.tran_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      payee_netsuite_id = EXCLUDED.payee_netsuite_id,
      payee_name = EXCLUDED.payee_name,
      total = EXCLUDED.total,
      status = EXCLUDED.status,
      status_label = EXCLUDED.status_label,
      voided = EXCLUDED.voided,
      memo = EXCLUDED.memo,
      lines = coalesce(EXCLUDED.lines, d.lines),
      gone_at = NULL,
      changed_at = now()
    WHERE (d.tran_type, d.tranid, d.trandate, d.payee_netsuite_id, d.payee_name, d.total,
           d.status, d.status_label, d.voided, d.memo, d.lines, d.gone_at)
      IS DISTINCT FROM (EXCLUDED.tran_type, EXCLUDED.tranid, EXCLUDED.trandate, EXCLUDED.payee_netsuite_id,
           EXCLUDED.payee_name, EXCLUDED.total, EXCLUDED.status, EXCLUDED.status_label, EXCLUDED.voided,
           EXCLUDED.memo, coalesce(EXCLUDED.lines, d.lines), NULL::timestamptz)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  RETURN jsonb_build_object('received', jsonb_array_length(p->'rows'), 'added', v_added, 'changed', v_changed);
END;
$$;

-- Once a run has read every check, card charge and card refund id NetSuite
-- has, marks the rows NetSuite no longer lists as gone. A read that looks
-- cut short (none, or under half of the rows still here) marks nothing and
-- says so. p:
--   { netsuite_ids: [every id NetSuite listed] }
-- Returns { listed, here, gone, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_spending_finish(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_spending'));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_spending WHERE gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_spending d SET gone_at = now()
  WHERE d.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = d.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- One company's NetSuite checks and card charges and refunds for one month:
-- those NetSuite booked into it (gl_netsuite_transactions.posting_month), and
-- those dated in it that the copy of NetSuite's GL has booked into no month,
-- as bills are read (migration 384). Each comes with its lines from the copy
-- (null until a run could read them), its payee's name (from the vendors
-- copy, migration 363, when the payee is a vendor), and the GL lines NetSuite
-- posted for it (migration 361). A document is a company's when NetSuite
-- posted a GL line of it to that company; one with no GL line in the copy
-- comes back for every company. Also:
--   items:      the copied items the lines name, with their type and asset,
--               expense and income accounts
--   not_copied: checks and card charges and refunds the GL copy has booked
--               into the month that the copy of the documents doesn't (yet)
CREATE OR REPLACE FUNCTION public.gl_spending_month(p_company TEXT, p_month DATE)
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
    SELECT s.netsuite_id, s.tran_type, s.tranid, s.trandate, s.payee_netsuite_id, s.payee_name, s.total,
           s.status_label, s.voided, s.lines, t.posting_month
    FROM public.gl_netsuite_spending s
    CROSS JOIN bounds m
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = s.netsuite_id
    WHERE s.gone_at IS NULL
      AND s.trandate >= m.m_from
      AND s.trandate < m.m_to
      AND (t.posting_month IS NULL OR t.posting_month = m.m_from)
    UNION ALL
    -- Dated in another month, but booked by NetSuite into this one.
    SELECT s.netsuite_id, s.tran_type, s.tranid, s.trandate, s.payee_netsuite_id, s.payee_name, s.total,
           s.status_label, s.voided, s.lines, t.posting_month
    FROM public.gl_netsuite_transactions t
    CROSS JOIN bounds m
    JOIN public.gl_netsuite_spending s ON s.netsuite_id = t.netsuite_id
    WHERE t.posting_month = m.m_from
      AND s.gone_at IS NULL
      AND (s.trandate < m.m_from OR s.trandate >= m.m_to)
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
    'documents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', x.netsuite_id,
        'type', x.tran_type,
        'number', x.tranid,
        'date', to_char(x.trandate, 'YYYY-MM-DD'),
        'posting_month', to_char(x.posting_month, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'status', x.status_label,
        'payee', coalesce(v.name, x.payee_name),
        'payee_netsuite_id', x.payee_netsuite_id,
        'companies', to_jsonb(x.companies),
        'lines', x.lines,
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
      LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.payee_netsuite_id
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
    'not_copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', t.netsuite_id, 'type', t.tran_type, 'number', t.tranid)
                                ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_transactions t
      CROSS JOIN bounds m
      WHERE t.tran_type IN ('Check', 'CardChrg', 'CardRfnd')
        AND t.posting_month = m.m_from
        AND (p_company IS NULL OR EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l JOIN public.gl_companies c ON c.id = l.company_id
          WHERE l.transaction_id = t.netsuite_id AND c.code = p_company
        ))
        AND NOT EXISTS (
          SELECT 1 FROM public.gl_netsuite_spending s WHERE s.netsuite_id = t.netsuite_id AND s.gone_at IS NULL
        )
    )
  )
$$;

-- For the items the copy of NetSuite's items has no account for, the
-- accounts NetSuite's GL (migration 361) posted their lines on the copied
-- checks and card charges and refunds to, as gl_bill_item_accounts (migration
-- 385) does for bills, so the spending rule can go where NetSuite goes.
CREATE OR REPLACE FUNCTION public.gl_spending_item_accounts(p_items TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('item', u.item, 'account', u.account, 'lines', u.lines)
                            ORDER BY u.item, u.lines DESC, u.account), '[]'::jsonb)
  FROM (
    SELECT l.line->>'item' AS item, g.netsuite_account_id AS account, count(*) AS lines
    FROM public.gl_netsuite_spending s
    CROSS JOIN LATERAL jsonb_array_elements(coalesce(s.lines, '[]'::jsonb)) AS l(line)
    JOIN public.gl_netsuite_lines g ON g.transaction_id = s.netsuite_id AND g.line_id = l.line->>'line_id'
    WHERE s.gone_at IS NULL
      AND l.line->>'item' = ANY (coalesce(p_items, '{}'::text[]))
    GROUP BY 1, 2
  ) u
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_spending ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_spending FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_spending_apply(jsonb)',
    'public.gl_netsuite_spending_finish(jsonb)',
    'public.gl_spending_month(text, date)',
    'public.gl_spending_item_accounts(text[])'
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

COMMENT ON TABLE gl_netsuite_spending IS 'Migration 391: NetSuite''s checks (Check), credit card charges (CardChrg) and credit card refunds (CardRfnd) with their lines, copied every two hours by src/lib/books/netsuite-spending.ts for the spending rule''s check. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_spending.tran_type IS 'Check: money paid straight from a bank account. CardChrg: a purchase on a credit card. CardRfnd: money a vendor put back on a credit card.';
COMMENT ON COLUMN gl_netsuite_spending.payee_netsuite_id IS 'Who was paid, or who refunded: NetSuite''s internal id for the document''s payee (its entity), a vendor, an employee or anyone else NetSuite lists. NULL when it names none.';
COMMENT ON COLUMN gl_netsuite_spending.total IS 'The document''s total as NetSuite gives it (foreigntotal, in the document''s currency), kept positive.';
COMMENT ON COLUMN gl_netsuite_spending.voided IS 'NetSuite''s status for it reads Voided.';
COMMENT ON COLUMN gl_netsuite_spending.lines IS 'Its lines but the line for the account the money comes out of, from NetSuite''s transaction lines: [{line_id, item, account, amount, own_amount, quantity, memo, tax}]. item is the item''s NetSuite id (null on an expense line), account the line''s expense account when NetSuite gives one, amount its net amount and own_amount its own (foreignamount), both signed as NetSuite gives them. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_spending.gone_at IS 'When a whole read of NetSuite''s check and card ids no longer had it. NULL = still in NetSuite.';
COMMENT ON COLUMN gl_netsuite_spending.changed_at IS 'When the copy last changed: added, or anything NetSuite holds for it changed.';
COMMENT ON FUNCTION public.gl_spending_month(text, date) IS 'Migration 391: one company''s NetSuite checks and card charges and refunds for one month (those NetSuite booked into it, and those dated in it that the copy of NetSuite''s GL has booked into no month), each with its lines, payee and the GL lines NetSuite posted for it (migration 361), plus the copied items the lines name and the GL copy''s documents not copied yet, for the spending rule''s check. Service role only.';
COMMENT ON FUNCTION public.gl_spending_item_accounts(text[]) IS 'Migration 391: for each of the given NetSuite item ids, the accounts NetSuite''s GL (migration 361) posted the item''s lines on the copied checks and card charges and refunds to, with how many lines: [{item, account, lines}], most used first. Where the spending rule posts an item the copy of NetSuite''s items has no account for. Service role only.';
