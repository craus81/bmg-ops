-- Migration 496: FleetSuite's own books, part 65 — Missouri sales tax: each
-- location's rate with the day it starts, the month's worksheet, and each
-- return held against it.
--
-- The NetSuite Exit Checklist's "Missouri sales tax" (thread "Replacing
-- NetSuite with FleetSuite"; src/lib/books/sales-tax-worksheet.ts,
-- /api/admin/books/sales-tax, page /admin/books/sales-tax, docs/books.md
-- "Sales tax"): what goes on a month's Missouri sales tax return, worked out
-- from the invoices, credit memos and cash sales NetSuite posted that month
-- by FleetSuite's own rule, next to the tax NetSuite charged on them and the
-- sales tax account, so the return can be filed from FleetSuite and checked
-- once it's filed.
--
--   * sales_tax_rates: each NetSuite location's sales tax rate, as a percent,
--     from the day it starts until the next one. Missouri's rates change at
--     the start of a quarter, and each location has its own. Started here
--     from Settings → Sales Tax (the one rate quotes use) for O'Fallon,
--     Wentzville and Kansas City from January 1, 2025, which is the rate
--     FleetSuite's own invoice copies use at every Missouri location today.
--     Social Circle, Georgia has none: FleetSuite doesn't tax work there
--     (owner, 2026-10-09). Super admins add and remove rates.
--   * sales_tax_returns: a company's return for a month as it was filed,
--     typed in after filing (gross receipts, adjustments, taxable sales, tax,
--     the timely payment allowance and what was paid), by the bookkeeper or a
--     super admin, to be held against the month's worksheet. Corrected in
--     place; every change is in the audit log. sales_tax_return_save(p) and
--     sales_tax_return_remove(p) type one in, correct it and remove it, each
--     refused when someone else saved it since the page saw it.
--   * gl_sales_tax_month(p_company, p_month, p_tax_accounts, p_limit), one
--     read of what the worksheet is worked out from:
--       - documents: each invoice, credit memo, cash sale and cash refund the
--         copy of NetSuite's general ledger posted to the company in the
--         month, with every GL line the company has on it (its account and
--         that account's type in the chart, location and customer) and, when
--         the ledger mirror has copied its lines, each of them (item, number,
--         whether it's a tax line, NetSuite's own signed amount), matched to
--         the GL lines by NetSuite's line id;
--       - items and parts: the lists copy's and FleetSuite's catalog's take
--         on the items on those lines (number, type, an admin's tax
--         override); tax_codes: the tax codes on their tax lines and rates;
--         locations: every NetSuite location's name;
--       - customers: for each customer on the documents, FleetSuite's name for
--         it, how many FleetSuite customers have that NetSuite id and how many
--         of those are tax exempt, the exemption certificate on file (its
--         number, the latest expiry, how many certificate files), and whether
--         NetSuite's customer list has it taxable;
--       - account: the sales tax accounts (p_tax_accounts, NetSuite's ids) in
--         the copy of NetSuite's ledger: what they held on December 31, 2024
--         and before the month, what the month's documents moved them by,
--         kind by kind, the other documents on them (payments to the state,
--         journal entries) in the month and in the month after, when the
--         month's return is paid, the first p_limit (1 to 1000) of each with
--         how many there are and what they come to, and what FleetSuite's own
--         books moved them by through the month.
--     Amounts are decimal strings; on the sales tax accounts, money owed to
--     the state is positive (credit less debit).
--
-- Nothing here moves money, posts to the books or is sent to NetSuite.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── Each location's rate, from the day it starts ───────────────────────────

CREATE TABLE IF NOT EXISTS sales_tax_rates (
  -- NetSuite's id for the location.
  location_id TEXT NOT NULL CHECK (location_id ~ '^[0-9]+$'),
  starts_on DATE NOT NULL CHECK (starts_on >= DATE '2025-01-01'),
  -- A percent: 7.95 is 7.95%.
  rate_pct NUMERIC(6,3) NOT NULL CHECK (rate_pct >= 0 AND rate_pct < 100),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 200)),
  -- NULL for the rates this migration started from Settings → Sales Tax.
  entered_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, starts_on)
);

-- O'Fallon, Wentzville and Kansas City (src/lib/invoice-location.ts's known
-- ids) at the rate FleetSuite charges everywhere in Missouri today, once:
-- a rate a super admin later removes doesn't come back.
DO $$
DECLARE
  v_pct NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sales_tax_rates) THEN
    IF to_regclass('public.quote_settings') IS NOT NULL THEN
      SELECT q.sales_tax_rate_pct INTO v_pct FROM public.quote_settings q WHERE q.id = 1;
    END IF;
    INSERT INTO public.sales_tax_rates (location_id, starts_on, rate_pct, note)
    SELECT l.id, DATE '2025-01-01', coalesce(v_pct, 7.95), 'From Settings → Sales Tax, the rate quotes use'
    FROM (VALUES ('1'), ('2'), ('3')) AS l(id);
  END IF;
END $$;

-- ── Each return as it was filed ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_tax_returns (
  company TEXT NOT NULL REFERENCES gl_companies(code) ON DELETE RESTRICT,
  -- The month the return is for.
  month DATE NOT NULL CHECK (EXTRACT(DAY FROM month) = 1 AND month >= DATE '2025-01-01'),
  filed_on DATE NOT NULL,
  gross_cents BIGINT NOT NULL CHECK (gross_cents BETWEEN -10000000000 AND 10000000000),
  adjustments_cents BIGINT NOT NULL CHECK (adjustments_cents BETWEEN -10000000000 AND 10000000000),
  taxable_cents BIGINT NOT NULL CHECK (taxable_cents BETWEEN -10000000000 AND 10000000000),
  tax_cents BIGINT NOT NULL CHECK (tax_cents BETWEEN -10000000000 AND 10000000000),
  -- The timely payment allowance taken, 0 when none was.
  allowance_cents BIGINT NOT NULL DEFAULT 0 CHECK (allowance_cents BETWEEN 0 AND 10000000000),
  paid_cents BIGINT NOT NULL CHECK (paid_cents BETWEEN -10000000000 AND 10000000000),
  note TEXT CHECK (note IS NULL OR (btrim(note) <> '' AND length(note) <= 300)),
  entered_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  entered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company, month),
  -- A month's return is filed once the month is over.
  CONSTRAINT sales_tax_returns_filed_after CHECK (filed_on >= (month + INTERVAL '1 month')::date)
);

-- ── What a month's worksheet is worked out from ────────────────────────────

CREATE OR REPLACE FUNCTION public.gl_sales_tax_month(p_company TEXT, p_month DATE, p_tax_accounts TEXT[], p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
  v_next DATE;
  v_out JSONB;
BEGIN
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'gl: month must be the first day of a month';
  END IF;
  IF p_month < DATE '2025-01-01' THEN
    RAISE EXCEPTION 'gl: month must be from January 2025, when the GL copy starts';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'gl: limit must be from 1 to 1000';
  END IF;
  IF p_tax_accounts IS NULL OR EXISTS (
    SELECT 1 FROM unnest(p_tax_accounts) AS a(id) WHERE a.id IS NULL OR a.id !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'gl: tax accounts must be NetSuite account ids';
  END IF;
  SELECT c.id INTO v_company FROM public.gl_companies c WHERE c.code = p_company;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: no company %', coalesce(p_company, '(none)');
  END IF;
  v_next := (p_month + INTERVAL '1 month')::date;

  WITH docs AS (
    SELECT t.netsuite_id AS id, t.tran_type, t.tranid, t.trandate
    FROM public.gl_netsuite_transactions t
    WHERE t.posting_month = p_month
      AND t.tran_type IN ('CustInvc', 'CustCred', 'CashSale', 'CashRfnd')
      AND EXISTS (
        SELECT 1 FROM public.gl_netsuite_lines l WHERE l.transaction_id = t.netsuite_id AND l.company_id = v_company
      )
  ),
  mirrored AS (
    -- The ledger mirror's copy of each, when it has the document's lines.
    SELECT d.id AS doc_id, i.id AS document_id
    FROM docs d
    JOIN public.ledger_invoices i ON i.source = 'netsuite' AND i.external_id = d.tran_type || '/' || d.id
    WHERE i.lines_synced_at IS NOT NULL
  ),
  mirror_lines AS (
    SELECT m.doc_id, il.line_external_id AS line_id, il.line_no, il.line_kind AS kind, il.item_external_id AS item_id,
           il.item_number, il.raw->>'netamount' AS netamount
    FROM mirrored m
    JOIN public.ledger_invoice_lines il ON il.document_id = m.document_id
  ),
  entities AS (
    SELECT DISTINCT l.entity_id
    FROM public.gl_netsuite_lines l
    JOIN docs d ON d.id = l.transaction_id
    WHERE l.company_id = v_company AND l.entity_id IS NOT NULL
  ),
  tax_lines AS (
    -- The company's lines on the sales tax accounts through the month after, owed to the state positive.
    SELECT l.transaction_id, l.line_id, l.posting_month AS month, l.credit - l.debit AS amount, l.memo, l.entity_id
    FROM public.gl_netsuite_lines l
    WHERE l.company_id = v_company AND l.netsuite_account_id = ANY (p_tax_accounts) AND l.posting_month <= v_next
  ),
  tax_docs AS (
    -- Each document's lines on them in the month and the month after.
    SELECT x.month, x.transaction_id, t.tran_type, t.tranid, t.trandate, sum(x.amount) AS amount,
           (array_agg(btrim(x.memo) ORDER BY x.line_id::bigint) FILTER (WHERE btrim(x.memo) <> ''))[1] AS memo,
           (array_agg(x.entity_id ORDER BY x.line_id::bigint) FILTER (WHERE x.entity_id IS NOT NULL))[1] AS entity_id
    FROM tax_lines x
    JOIN public.gl_netsuite_transactions t ON t.netsuite_id = x.transaction_id
    WHERE x.month >= p_month
    GROUP BY x.month, x.transaction_id, t.tran_type, t.tranid, t.trandate
  ),
  others AS (
    -- Payments to the state, journal entries and anything else that isn't a sale or a return.
    SELECT * FROM tax_docs WHERE tran_type NOT IN ('CustInvc', 'CustCred', 'CashSale', 'CashRfnd')
  ),
  other_months AS (
    -- The month's, and the month after's, when the month's return is paid.
    SELECT w.month, jsonb_build_object(
      'list', (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'id', o.transaction_id,
          'type', o.tran_type,
          'number', o.tranid,
          'date', to_char(o.trandate, 'YYYY-MM-DD'),
          'memo', o.memo,
          'name', (
            SELECT n.name FROM public.gl_netsuite_lists n
            WHERE n.kind IN ('vendor', 'customer') AND n.netsuite_id = o.entity_id
            ORDER BY n.kind DESC LIMIT 1
          ),
          'amount', o.amount::text
        ) ORDER BY o.trandate, o.transaction_id::bigint), '[]'::jsonb)
        FROM (SELECT * FROM others x WHERE x.month = w.month ORDER BY x.trandate, x.transaction_id::bigint LIMIT p_limit) o
      ),
      'count', (SELECT count(*) FROM others x WHERE x.month = w.month),
      'total', (SELECT coalesce(sum(x.amount), 0)::text FROM others x WHERE x.month = w.month)
    ) AS summary
    FROM (VALUES (p_month), (v_next)) AS w(month)
  )
  SELECT jsonb_build_object(
    'documents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', d.id,
        'type', d.tran_type,
        'number', d.tranid,
        'date', to_char(d.trandate, 'YYYY-MM-DD'),
        'gl', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', l.line_id,
            'account', l.netsuite_account_id,
            'account_type', a.account_type,
            'debit', l.debit::text,
            'credit', l.credit::text,
            'location_id', l.location_id,
            'entity_id', l.entity_id
          ) ORDER BY l.line_id::bigint), '[]'::jsonb)
          FROM public.gl_netsuite_lines l
          LEFT JOIN public.gl_accounts a ON a.netsuite_account_id = l.netsuite_account_id
          WHERE l.transaction_id = d.id AND l.company_id = v_company
        ),
        'copied', EXISTS (SELECT 1 FROM mirrored m WHERE m.doc_id = d.id),
        'lines', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'line_id', ml.line_id,
            'line_no', ml.line_no,
            'kind', ml.kind,
            'item_id', ml.item_id,
            'item_number', ml.item_number,
            'netamount', ml.netamount
          ) ORDER BY ml.line_no NULLS LAST, ml.line_id), '[]'::jsonb)
          FROM mirror_lines ml
          WHERE ml.doc_id = d.id
        )
      ) ORDER BY d.trandate, d.id::bigint), '[]'::jsonb)
      FROM docs d
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('number', l.name, 'type', l.details->>'item_type')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (SELECT ml.item_id FROM mirror_lines ml WHERE ml.kind <> 'tax')
    ),
    'parts', (
      SELECT coalesce(jsonb_object_agg(p.netsuite_id, jsonb_build_object(
        'number', p.item_number, 'type', p.item_type, 'taxable_override', p.taxable_override
      )), '{}'::jsonb)
      FROM public.netsuite_parts p
      WHERE p.netsuite_id IN (SELECT ml.item_id FROM mirror_lines ml WHERE ml.kind <> 'tax')
    ),
    'tax_codes', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('name', l.name, 'rate', l.details->>'rate')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'tax_code' AND l.netsuite_id IN (SELECT ml.item_id FROM mirror_lines ml WHERE ml.kind = 'tax')
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'location'
    ),
    'customers', (
      SELECT coalesce(jsonb_object_agg(e.entity_id, jsonb_build_object(
        'name', coalesce(
          (SELECT nullif(btrim(c.company_name), '') FROM public.customers c
           WHERE c.netsuite_id::text = e.entity_id AND nullif(btrim(c.company_name), '') IS NOT NULL
           ORDER BY c.id LIMIT 1),
          (SELECT lc.display_name FROM public.ledger_customers lc
           WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || e.entity_id),
          (SELECT cl.name FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = e.entity_id)
        ),
        'rows', (SELECT count(*) FROM public.customers c WHERE c.netsuite_id::text = e.entity_id),
        'exempt', (SELECT count(*) FROM public.customers c WHERE c.netsuite_id::text = e.entity_id AND c.tax_exempt IS TRUE),
        'cert_number', (
          SELECT btrim(c.tax_exempt_cert_number) FROM public.customers c
          WHERE c.netsuite_id::text = e.entity_id AND btrim(c.tax_exempt_cert_number) <> ''
          ORDER BY c.id LIMIT 1
        ),
        'cert_expires', (
          SELECT to_char(max(c.tax_exempt_expires_at), 'YYYY-MM-DD') FROM public.customers c WHERE c.netsuite_id::text = e.entity_id
        ),
        'cert_files', (
          SELECT count(*) FROM public.customer_files f
          JOIN public.customers c ON c.id = f.customer_id
          WHERE c.netsuite_id::text = e.entity_id AND f.category = 'tax_exempt_cert'
        ),
        'netsuite_taxable', (
          SELECT cl.details->>'taxable' FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = e.entity_id
        )
      )), '{}'::jsonb)
      FROM entities e
    ),
    'account', jsonb_build_object(
      'opening', (
        SELECT coalesce(sum(o.credit - o.debit), 0)::text
        FROM public.gl_netsuite_opening o
        WHERE o.company_id = v_company AND o.netsuite_account_id = ANY (p_tax_accounts)
      ),
      'before', (SELECT coalesce(sum(x.amount), 0)::text FROM tax_lines x WHERE x.month < p_month),
      'moves', (
        SELECT coalesce(jsonb_agg(jsonb_build_object('type', m.tran_type, 'documents', m.documents, 'amount', m.amount::text)
                                  ORDER BY m.tran_type), '[]'::jsonb)
        FROM (
          SELECT tran_type, count(*) AS documents, sum(amount) AS amount FROM tax_docs WHERE month = p_month GROUP BY tran_type
        ) m
      ),
      'others', (SELECT w.summary FROM other_months w WHERE w.month = p_month),
      'next', (SELECT w.summary FROM other_months w WHERE w.month = v_next),
      'books', (
        SELECT coalesce(sum(l.credit - l.debit), 0)::text
        FROM public.gl_lines l
        JOIN public.gl_accounts a ON a.id = l.account_id
        WHERE l.company_id = v_company AND a.netsuite_account_id = ANY (p_tax_accounts) AND l.entry_date < v_next
      )
    )
  ) INTO v_out;

  RETURN v_out;
END;
$$;

-- ── Typing in a return as filed ────────────────────────────────────────────

-- Saves a month's return as it was filed. p:
--   { company, month: 'YYYY-MM-01', seen: its updated_at as the page saw it, or null for a return not typed in yet,
--     filed_on, gross_cents, adjustments_cents, taxable_cents, tax_cents, allowance_cents, paid_cents, note, by }
-- Answers { state: 'saved', updated_at }, with unchanged: true when it was saved that way already, or 'changed'
-- when it was saved or removed since the page saw it.
CREATE OR REPLACE FUNCTION public.sales_tax_return_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_month DATE := (p->>'month')::date;
  v_filed DATE := (p->>'filed_on')::date;
  v_gross BIGINT := (p->>'gross_cents')::bigint;
  v_adjustments BIGINT := (p->>'adjustments_cents')::bigint;
  v_taxable BIGINT := (p->>'taxable_cents')::bigint;
  v_tax BIGINT := (p->>'tax_cents')::bigint;
  v_allowance BIGINT := (p->>'allowance_cents')::bigint;
  v_paid BIGINT := (p->>'paid_cents')::bigint;
  v_note TEXT := nullif(btrim(p->>'note'), '');
  v_by UUID := nullif(p->>'by', '')::uuid;
  v_row public.sales_tax_returns;
BEGIN
  SELECT * INTO v_row FROM public.sales_tax_returns WHERE company = v_company AND month = v_month FOR UPDATE;
  IF NOT FOUND THEN
    IF p->>'seen' IS NOT NULL THEN
      -- Removed since the page saw it.
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    INSERT INTO public.sales_tax_returns (company, month, filed_on, gross_cents, adjustments_cents, taxable_cents, tax_cents,
                                          allowance_cents, paid_cents, note, entered_by, updated_by)
    VALUES (v_company, v_month, v_filed, v_gross, v_adjustments, v_taxable, v_tax, v_allowance, v_paid, v_note, v_by, v_by)
    ON CONFLICT (company, month) DO NOTHING
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
      -- Typed in by someone else at the same moment.
      RETURN jsonb_build_object('state', 'changed');
    END IF;
    RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at);
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;

  IF ROW(v_row.filed_on, v_row.gross_cents, v_row.adjustments_cents, v_row.taxable_cents, v_row.tax_cents, v_row.allowance_cents,
         v_row.paid_cents, v_row.note)
     IS NOT DISTINCT FROM ROW(v_filed, v_gross, v_adjustments, v_taxable, v_tax, v_allowance, v_paid, v_note) THEN
    RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at, 'unchanged', true);
  END IF;
  UPDATE public.sales_tax_returns
  SET filed_on = v_filed, gross_cents = v_gross, adjustments_cents = v_adjustments, taxable_cents = v_taxable, tax_cents = v_tax,
      allowance_cents = v_allowance, paid_cents = v_paid, note = v_note, updated_by = v_by, updated_at = now()
  WHERE company = v_company AND month = v_month
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('state', 'saved', 'updated_at', v_row.updated_at);
END;
$$;

-- Removes a month's return, one typed in for the wrong month say. p: { company, month: 'YYYY-MM-01', seen }.
-- Answers { state: 'removed' }, 'changed' when it was saved since the page saw it, or 'gone' when there's none.
CREATE OR REPLACE FUNCTION public.sales_tax_return_remove(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company TEXT := btrim(p->>'company');
  v_month DATE := (p->>'month')::date;
  v_row public.sales_tax_returns;
BEGIN
  SELECT * INTO v_row FROM public.sales_tax_returns WHERE company = v_company AND month = v_month FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'gone');
  END IF;
  IF v_row.updated_at IS DISTINCT FROM (p->>'seen')::timestamptz THEN
    RETURN jsonb_build_object('state', 'changed');
  END IF;
  DELETE FROM public.sales_tax_returns WHERE company = v_company AND month = v_month;
  RETURN jsonb_build_object('state', 'removed');
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.sales_tax_rates', 'public.sales_tax_returns'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_sales_tax_month(text, date, text[], integer)', 'public.sales_tax_return_save(jsonb)', 'public.sales_tax_return_remove(jsonb)'
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

COMMENT ON TABLE sales_tax_rates IS 'Migration 496: each NetSuite location''s sales tax rate, a percent, from the day it starts until the next one (src/lib/books/sales-tax-worksheet.ts). Started from Settings → Sales Tax for O''Fallon, Wentzville and Kansas City from January 1, 2025; Social Circle, Georgia has none. Super admins add and remove rates. Service-role write and read.';
COMMENT ON TABLE sales_tax_returns IS 'Migration 496: a company''s sales tax return for a month as it was filed (gross receipts, adjustments, taxable sales, tax, the timely payment allowance taken and what was paid, in cents), typed in by the bookkeeper or a super admin to be held against the month''s worksheet. Corrected in place; changes are in the audit log. Service-role write and read.';
COMMENT ON FUNCTION public.gl_sales_tax_month(text, date, text[], integer) IS 'Migration 496: one company''s invoices, credit memos and cash sales NetSuite posted in a month, each with its GL lines and the ledger mirror''s lines, the items, tax codes, locations and customers on them, and the sales tax accounts in NetSuite''s ledger and FleetSuite''s books, for Books → Sales tax. Reads only. Service role only.';
COMMENT ON FUNCTION public.sales_tax_return_save(jsonb) IS 'Migration 496: saves a month''s sales tax return as filed, refusing when it was saved or removed since the page saw it. Service role only.';
COMMENT ON FUNCTION public.sales_tax_return_remove(jsonb) IS 'Migration 496: removes a month''s sales tax return, refusing when it was saved since the page saw it. Service role only.';
