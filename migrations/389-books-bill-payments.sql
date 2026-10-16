-- Migration 389: FleetSuite's own books, part 11b — bill payments, copied
-- from NetSuite and checked against its GL.
--
-- Owner decision 2026-10-16 (thread "Replacing NetSuite with FleetSuite",
-- "Bill payments"): with vendor bills posting (migration 386), the payments
-- that pay them come next, copied and checked against NetSuite first, posted
-- only after a preview and the owner's OK. A bill payment (NetSuite's
-- VendPymt) pays what BMG owes a vendor: it takes the bills it pays off
-- payables, and the money comes out of the account it was paid from. They
-- are copied every two hours with the bills each one paid
-- (src/lib/books/netsuite-bill-payments.ts, from
-- /api/cron/books-netsuite-bill-payments at :21 on odd hours and "Copy now"
-- on the invoices page's Bill payments switch), and each is checked against
-- the GL lines NetSuite posted for it with the bill payment rule,
-- bill_payment@1 (src/lib/books/bill-payment-rule.ts,
-- src/lib/books/bill-payment-check.ts).
--
-- The ledger mirror's ledger_payments (migration 314) copies only customer
-- payments from NetSuite, and its delete sweep takes the NetSuite rows of
-- its tables for its own documents. So the copy is a books table of its own,
-- like the bills (migration 384): it follows NetSuite until the changeover,
-- nothing is written back, and a row is never deleted. gone_at records when
-- NetSuite stopped listing it, and it comes back if NetSuite lists it again.
-- Nothing posts to the journal yet.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_bill_payments (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (tran_type IN ('VendPymt')),
  tranid TEXT,
  trandate DATE NOT NULL,
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
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
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_bill_payments_date ON gl_netsuite_bill_payments(trandate);

-- Applies one page of NetSuite bill payments. p:
--   { rows: [{ netsuite_id, tran_type, tranid?, trandate, vendor_netsuite_id?, vendor_name?,
--              total, status?, status_label?, voided?, memo?, links? }] }
-- links, when given, are the documents the payment paid: [{ netsuite_id,
-- type, number, amount, link_type }], amounts positive. A row without links
-- keeps the ones it has, so a run that couldn't read them changes nothing
-- there. A new row is added. A row whose content differs is updated, and one
-- that had gone from NetSuite is back. The whole page applies or none of it
-- does. Returns { received, added, changed }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_bill_payments_apply(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_bill_payments'));

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
  WHERE coalesce(x.v->>'tran_type', '') <> 'VendPymt'
     OR nullif(x.v->>'trandate', '') IS NULL
     OR nullif(x.v->>'total', '') IS NULL
     OR (x.v ? 'links' AND jsonb_typeof(x.v->'links') IS DISTINCT FROM 'array')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % isn''t a bill payment with a date and total', v_bad;
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
           CASE WHEN x.v ? 'links' THEN x.v->'links' END AS links
    FROM jsonb_array_elements(p->'rows') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_bill_payments AS d (
      netsuite_id, tran_type, tranid, trandate, vendor_netsuite_id, vendor_name,
      total, status, status_label, voided, memo, links
    )
    SELECT i.netsuite_id, i.tran_type, i.tranid, i.trandate, i.vendor_netsuite_id, i.vendor_name,
           i.total, i.status, i.status_label, i.voided, i.memo, i.links
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
      links = coalesce(EXCLUDED.links, d.links),
      gone_at = NULL,
      changed_at = now()
    WHERE (d.tran_type, d.tranid, d.trandate, d.vendor_netsuite_id, d.vendor_name, d.total,
           d.status, d.status_label, d.voided, d.memo, d.links, d.gone_at)
      IS DISTINCT FROM (EXCLUDED.tran_type, EXCLUDED.tranid, EXCLUDED.trandate, EXCLUDED.vendor_netsuite_id,
           EXCLUDED.vendor_name, EXCLUDED.total, EXCLUDED.status, EXCLUDED.status_label, EXCLUDED.voided,
           EXCLUDED.memo, coalesce(EXCLUDED.links, d.links), NULL::timestamptz)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  RETURN jsonb_build_object('received', jsonb_array_length(p->'rows'), 'added', v_added, 'changed', v_changed);
END;
$$;

-- Once a run has read every bill payment id NetSuite has, marks the rows
-- NetSuite no longer lists as gone. A read that looks cut short (none, or
-- under half of the rows still here) marks nothing and says so. p:
--   { netsuite_ids: [every id NetSuite listed] }
-- Returns { listed, here, gone, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_bill_payments_finish(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_bill_payments'));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_bill_payments WHERE gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_bill_payments d SET gone_at = now()
  WHERE d.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = d.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- One company's NetSuite bill payments for one month: those NetSuite booked
-- into it (gl_netsuite_transactions.posting_month), and those dated in it
-- that the copy of NetSuite's GL has booked into no month, as bills are read
-- (migration 384). Each comes with what it paid from the copy (null until a
-- run could read it), its vendor's name and payables account from the
-- vendors copy (migration 363), and the GL lines NetSuite posted for it
-- (migration 361). A payment is a company's when NetSuite posted a GL line
-- of it to that company; one with no GL line in the copy comes back for
-- every company. Also:
--   not_copied: bill payments the GL copy has booked into the month that
--               the copy of the payments doesn't (yet)
CREATE OR REPLACE FUNCTION public.gl_bill_payment_month(p_company TEXT, p_month DATE)
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
           b.status_label, b.voided, b.links, t.posting_month
    FROM public.gl_netsuite_bill_payments b
    CROSS JOIN bounds m
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = b.netsuite_id
    WHERE b.gone_at IS NULL
      AND b.trandate >= m.m_from
      AND b.trandate < m.m_to
      AND (t.posting_month IS NULL OR t.posting_month = m.m_from)
    UNION ALL
    -- Dated in another month, but booked by NetSuite into this one.
    SELECT b.netsuite_id, b.tran_type, b.tranid, b.trandate, b.vendor_netsuite_id, b.vendor_name, b.total,
           b.status_label, b.voided, b.links, t.posting_month
    FROM public.gl_netsuite_transactions t
    CROSS JOIN bounds m
    JOIN public.gl_netsuite_bill_payments b ON b.netsuite_id = t.netsuite_id
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
    'payments', (
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
    'not_copied', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('netsuite_id', t.netsuite_id, 'type', t.tran_type, 'number', t.tranid)
                                ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
      FROM public.gl_netsuite_transactions t
      CROSS JOIN bounds m
      WHERE t.tran_type = 'VendPymt'
        AND t.posting_month = m.m_from
        AND (p_company IS NULL OR EXISTS (
          SELECT 1 FROM public.gl_netsuite_lines l JOIN public.gl_companies c ON c.id = l.company_id
          WHERE l.transaction_id = t.netsuite_id AND c.code = p_company
        ))
        AND NOT EXISTS (
          SELECT 1 FROM public.gl_netsuite_bill_payments b WHERE b.netsuite_id = t.netsuite_id AND b.gone_at IS NULL
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
  ALTER TABLE gl_netsuite_bill_payments ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_bill_payments FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_bill_payments_apply(jsonb)',
    'public.gl_netsuite_bill_payments_finish(jsonb)',
    'public.gl_bill_payment_month(text, date)'
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

COMMENT ON TABLE gl_netsuite_bill_payments IS 'Migration 389: NetSuite''s bill payments (VendPymt) with the bills each one paid, copied every two hours by src/lib/books/netsuite-bill-payments.ts for the bill payment rule''s check. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_bill_payments.tran_type IS 'VendPymt: a bill payment, money paid to a vendor against what BMG owes it.';
COMMENT ON COLUMN gl_netsuite_bill_payments.vendor_netsuite_id IS 'Who was paid: NetSuite''s internal id for the payment''s payee (its entity), as the vendors copy names vendors.';
COMMENT ON COLUMN gl_netsuite_bill_payments.total IS 'The payment''s total as NetSuite gives it (foreigntotal, in the payment''s currency), kept positive: the money paid. A discount taken isn''t in it.';
COMMENT ON COLUMN gl_netsuite_bill_payments.voided IS 'NetSuite''s status for it reads Voided.';
COMMENT ON COLUMN gl_netsuite_bill_payments.links IS 'What it paid, from NetSuite''s transaction link table (its previous documents): the bills, and any bill credits applied with them. [{netsuite_id, type, number, amount, link_type}], amounts positive. NULL until a run could read them.';
COMMENT ON COLUMN gl_netsuite_bill_payments.gone_at IS 'When a whole read of NetSuite''s bill payment ids no longer had it. NULL = still in NetSuite.';
COMMENT ON COLUMN gl_netsuite_bill_payments.changed_at IS 'When the copy last changed: added, or anything NetSuite holds for it changed.';
COMMENT ON FUNCTION public.gl_bill_payment_month(text, date) IS 'Migration 389: one company''s NetSuite bill payments for one month (those NetSuite booked into it, and those dated in it that the copy of NetSuite''s GL has booked into no month), each with what it paid, its vendor''s payables account and the GL lines NetSuite posted for it (migration 361), plus the GL copy''s bill payments not copied yet, for the bill payment rule''s check. Service role only.';
