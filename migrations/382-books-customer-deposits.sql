-- Migration 382: FleetSuite's own books, part 10 — customer deposits and
-- their applications, copied from NetSuite and checked against its GL.
--
-- Owner decision 2026-10-15 (thread "Replacing NetSuite with FleetSuite"):
-- customer deposits are the next piece after payments, copied and checked
-- against NetSuite first, posted once they match. NetSuite keeps two
-- documents for them: the customer deposit (CustDep), money a customer pays
-- ahead of an invoice, and the deposit application (DepAppl), which applies
-- a deposit to an invoice, or to a refund. Both are copied every two hours
-- (src/lib/books/netsuite-deposits.ts, from /api/cron/books-netsuite-deposits
-- at :16 on odd hours and "Copy now" on the invoices page's Deposits switch),
-- and each is checked against the GL lines NetSuite posted for it with the
-- deposit rule, deposit@1 (src/lib/books/deposit-rule.ts,
-- src/lib/books/deposit-check.ts).
--
-- The ledger mirror's ledger_payments (migration 314) is not where they go:
-- its delete sweep takes every NetSuite row there for a customer payment and
-- would mark these deleted, and gl_payment_month would check them as
-- payments. So the copy is a books table of its own, like the NetSuite lists
-- (migration 363): it follows NetSuite until the changeover, nothing is
-- written back, and a row is never deleted. gone_at records when NetSuite
-- stopped listing it, and it comes back if NetSuite lists it again.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_deposits (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (tran_type IN ('CustDep', 'DepAppl')),
  tranid TEXT,
  trandate DATE NOT NULL,
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT,
  total NUMERIC(16,2) NOT NULL CHECK (total >= 0),
  status TEXT,
  status_label TEXT,
  voided BOOLEAN NOT NULL DEFAULT false,
  memo TEXT,
  links JSONB CHECK (links IS NULL OR jsonb_typeof(links) = 'array'),
  gone_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_deposits_date ON gl_netsuite_deposits(trandate);
-- A deposit's applications are the ones whose links name it.
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_deposits_links ON gl_netsuite_deposits USING gin (links jsonb_path_ops);
-- Which account holds the deposits is learned from every deposit in the GL copy.
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_transactions_type ON gl_netsuite_transactions(tran_type);

-- Applies one page of NetSuite customer deposits and deposit applications. p:
--   { rows: [{ netsuite_id, tran_type, tranid?, trandate, customer_netsuite_id?, customer_name?,
--              total, status?, status_label?, voided?, memo?, links? }] }
-- links, when given, is what the document applies: [{ netsuite_id, type, number, amount, link_type }].
-- A row without links keeps the ones it has, so a run that couldn't read
-- them changes nothing there. A new row is added. A row whose content
-- differs is updated, and one that had gone from NetSuite is back. The whole
-- page applies or none of it does. Returns { received, added, changed }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_deposits_apply(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_deposits'));

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
  WHERE coalesce(x.v->>'tran_type', '') NOT IN ('CustDep', 'DepAppl')
     OR nullif(x.v->>'trandate', '') IS NULL
     OR nullif(x.v->>'total', '') IS NULL
     OR (x.v ? 'links' AND jsonb_typeof(x.v->'links') IS DISTINCT FROM 'array')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % isn''t a customer deposit or deposit application with a date and total', v_bad;
  END IF;

  WITH incoming AS (
    SELECT x.v->>'netsuite_id' AS netsuite_id,
           x.v->>'tran_type' AS tran_type,
           nullif(btrim(x.v->>'tranid'), '') AS tranid,
           (x.v->>'trandate')::date AS trandate,
           nullif(x.v->>'customer_netsuite_id', '') AS customer_netsuite_id,
           nullif(btrim(x.v->>'customer_name'), '') AS customer_name,
           (x.v->>'total')::numeric(16,2) AS total,
           nullif(x.v->>'status', '') AS status,
           nullif(x.v->>'status_label', '') AS status_label,
           coalesce((x.v->>'voided')::boolean, false) AS voided,
           nullif(x.v->>'memo', '') AS memo,
           CASE WHEN x.v ? 'links' THEN x.v->'links' END AS links
    FROM jsonb_array_elements(p->'rows') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_deposits AS d (
      netsuite_id, tran_type, tranid, trandate, customer_netsuite_id, customer_name,
      total, status, status_label, voided, memo, links
    )
    SELECT i.netsuite_id, i.tran_type, i.tranid, i.trandate, i.customer_netsuite_id, i.customer_name,
           i.total, i.status, i.status_label, i.voided, i.memo, i.links
    FROM incoming i
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tran_type = EXCLUDED.tran_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      customer_netsuite_id = EXCLUDED.customer_netsuite_id,
      customer_name = EXCLUDED.customer_name,
      total = EXCLUDED.total,
      status = EXCLUDED.status,
      status_label = EXCLUDED.status_label,
      voided = EXCLUDED.voided,
      memo = EXCLUDED.memo,
      links = coalesce(EXCLUDED.links, d.links),
      gone_at = NULL,
      changed_at = now()
    WHERE (d.tran_type, d.tranid, d.trandate, d.customer_netsuite_id, d.customer_name, d.total,
           d.status, d.status_label, d.voided, d.memo, d.links, d.gone_at)
      IS DISTINCT FROM (EXCLUDED.tran_type, EXCLUDED.tranid, EXCLUDED.trandate, EXCLUDED.customer_netsuite_id,
           EXCLUDED.customer_name, EXCLUDED.total, EXCLUDED.status, EXCLUDED.status_label, EXCLUDED.voided,
           EXCLUDED.memo, coalesce(EXCLUDED.links, d.links), NULL::timestamptz)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  RETURN jsonb_build_object('received', jsonb_array_length(p->'rows'), 'added', v_added, 'changed', v_changed);
END;
$$;

-- Once a run has read every customer deposit and deposit application id
-- NetSuite has, marks the rows NetSuite no longer lists as gone. A read
-- that looks cut short (none, or under half of the rows still here) marks
-- nothing and says so. p:
--   { netsuite_ids: [every id NetSuite listed] }
-- Returns { listed, here, gone, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_deposits_finish(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_deposits'));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_deposits WHERE gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_deposits d SET gone_at = now()
  WHERE d.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = d.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- One company's NetSuite customer deposits and deposit applications dated in
-- one month, from the copy, each with what it applies (an application: the
-- deposit and the invoices), the applications that applied it (a deposit),
-- and the GL lines NetSuite posted for it (migration 361). A document is a
-- company's when NetSuite posted a GL line of it to that company; one with
-- no GL line in the copy comes back for every company, as a payment does.
-- Also:
--   accounts:   the accounts the company's deposits credit and its
--               applications debit, across the whole GL copy, by how many
--               documents use each: the deposit rule takes the customer
--               deposits account from these
--   not_copied: deposits and applications the GL copy has in the month that
--               the copy of the documents doesn't (yet)
CREATE OR REPLACE FUNCTION public.gl_deposit_month(p_company TEXT, p_month DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH month_docs AS (
    SELECT d.*
    FROM public.gl_netsuite_deposits d
    WHERE d.gone_at IS NULL
      AND d.trandate >= date_trunc('month', p_month)::date
      AND d.trandate < (date_trunc('month', p_month) + interval '1 month')::date
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
    'deposits', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'netsuite_id', x.netsuite_id,
        'type', x.tran_type,
        'number', x.tranid,
        'date', to_char(x.trandate, 'YYYY-MM-DD'),
        'total', x.total::text,
        'voided', x.voided,
        'status', x.status_label,
        'customer', x.customer_name,
        'companies', to_jsonb(x.companies),
        'links', coalesce(x.links, '[]'::jsonb),
        'applications', CASE WHEN x.tran_type = 'CustDep' THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'netsuite_id', a.netsuite_id,
            'number', a.tranid,
            'date', to_char(a.trandate, 'YYYY-MM-DD'),
            'links', a.links
          ) ORDER BY a.trandate, a.netsuite_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_deposits a
          WHERE a.tran_type = 'DepAppl'
            AND a.gone_at IS NULL
            AND a.links @> jsonb_build_array(jsonb_build_object('netsuite_id', x.netsuite_id))
        ) ELSE '[]'::jsonb END,
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
    ),
    'accounts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('account', u.account, 'documents', u.documents)
                                ORDER BY u.documents DESC, u.account), '[]'::jsonb)
      FROM (
        SELECT l.netsuite_account_id AS account, count(DISTINCT l.transaction_id) AS documents
        FROM public.gl_netsuite_transactions t
        JOIN public.gl_netsuite_lines l ON l.transaction_id = t.netsuite_id
        JOIN public.gl_companies c ON c.id = l.company_id
        WHERE t.tran_type IN ('CustDep', 'DepAppl')
          AND (p_company IS NULL OR c.code = p_company)
          AND ((t.tran_type = 'CustDep' AND l.credit > l.debit) OR (t.tran_type = 'DepAppl' AND l.debit > l.credit))
        GROUP BY l.netsuite_account_id
      ) u
    ),
    'not_copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', t.netsuite_id, 'type', t.tran_type, 'number', t.tranid)
                                ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_transactions t
      WHERE t.tran_type IN ('CustDep', 'DepAppl')
        AND t.trandate >= date_trunc('month', p_month)::date
        AND t.trandate < (date_trunc('month', p_month) + interval '1 month')::date
        AND (p_company IS NULL OR EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l JOIN public.gl_companies c ON c.id = l.company_id
          WHERE l.transaction_id = t.netsuite_id AND c.code = p_company
        ))
        AND NOT EXISTS (
          SELECT 1 FROM public.gl_netsuite_deposits d WHERE d.netsuite_id = t.netsuite_id AND d.gone_at IS NULL
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
  ALTER TABLE gl_netsuite_deposits ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_deposits FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_deposits_apply(jsonb)',
    'public.gl_netsuite_deposits_finish(jsonb)',
    'public.gl_deposit_month(text, date)'
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

COMMENT ON TABLE gl_netsuite_deposits IS 'Migration 382: NetSuite''s customer deposits (CustDep) and deposit applications (DepAppl), copied every two hours by src/lib/books/netsuite-deposits.ts for the deposit rule''s check. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_deposits.tran_type IS 'CustDep: money a customer paid ahead of an invoice. DepAppl: a deposit applied to an invoice or a refund.';
COMMENT ON COLUMN gl_netsuite_deposits.total IS 'The document''s total as NetSuite gives it (foreigntotal), kept positive: what was deposited, or what was applied.';
COMMENT ON COLUMN gl_netsuite_deposits.voided IS 'NetSuite''s status for it reads Voided.';
COMMENT ON COLUMN gl_netsuite_deposits.links IS 'What it applies, from NetSuite''s transaction link table (its previous documents): an application''s deposit and invoices, a deposit''s sales order when NetSuite links one. [{netsuite_id, type, number, amount, link_type}], amounts positive. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_deposits.gone_at IS 'When a whole read of NetSuite''s deposit ids no longer had it. NULL = still in NetSuite.';
COMMENT ON COLUMN gl_netsuite_deposits.changed_at IS 'When the copy last changed: added, or anything NetSuite holds for it changed.';
COMMENT ON FUNCTION public.gl_deposit_month(text, date) IS 'Migration 382: one company''s NetSuite customer deposits and deposit applications dated in one month, each with what it applies, what applied it and the GL lines NetSuite posted for it (migration 361), plus the accounts the company''s deposits post to and the GL copy''s documents not copied yet, for the deposit rule''s check. Service role only.';
