-- Migration 407: FleetSuite's own books, part 23 — FleetSuite's own copy of
-- each invoice it makes, next to NetSuite's.
--
-- Owner decision 2026-10-19 (thread "Replacing NetSuite with FleetSuite",
-- "Own invoices"): when FleetSuite makes an invoice in NetSuite it keeps its
-- own copy, worked out from what it billed by its own rules: the lines, the
-- sales tax, the terms and the due date (src/lib/books/own-invoices.ts,
-- docs/books.md "FleetSuite's own invoices"). Each copy is put next to
-- NetSuite's invoice as the ledger mirror copies it, so wherever FleetSuite
-- would bill differently shows up before FleetSuite bills on its own.
-- Posting the copies to the books comes after.
--   * gl_own_invoices and gl_own_invoice_lines, the copies, written only by
--     gl_own_invoice_save, which keeps each one whole: its subtotal and tax
--     add up from its lines and its total from those, and saving the same
--     NetSuite invoice again changes nothing;
--   * gl_own_invoice_pairs(from, to, netsuite_id), the copies made on those
--     days, or the one, each with NetSuite's invoice (ledger_invoices,
--     migration 314) and the location NetSuite booked it to (its receivable
--     line in the copy of NetSuite's general ledger, migration 361), and the
--     names the pages show;
--   * gl_own_invoice_months(), how many copies were made each month.
-- The NetSuite lists (migration 363) gain NetSuite's customers, so a copy
-- knows each customer's terms, and the check can say how NetSuite taxes
-- one.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── NetSuite's customers, in the lists ─────────────────────────────────────

ALTER TABLE gl_netsuite_lists DROP CONSTRAINT IF EXISTS gl_netsuite_lists_kind_check;
ALTER TABLE gl_netsuite_lists ADD CONSTRAINT gl_netsuite_lists_kind_check
  CHECK (kind IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item', 'customer'));

-- As migration 363 has it, with customers.
CREATE OR REPLACE FUNCTION public.gl_netsuite_lists_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind TEXT := p->>'kind';
  v_bad TEXT;
  v_added INTEGER;
  v_changed INTEGER;
BEGIN
  IF v_kind IS NULL OR v_kind NOT IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item', 'customer') THEN
    RAISE EXCEPTION 'gl: unknown NetSuite list %', coalesce(v_kind, '(none)');
  END IF;
  IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: rows must be a list';
  END IF;
  -- One writer per list at a time: the cron and "Sync now" can land together.
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_lists:' || v_kind));

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
    RAISE EXCEPTION 'gl: NetSuite % % is in the list twice', v_kind, v_bad;
  END IF;
  SELECT x.v->>'netsuite_id' INTO v_bad
  FROM jsonb_array_elements(p->'rows') AS x(v)
  WHERE nullif(btrim(x.v->>'name'), '') IS NULL
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite % % has no name', v_kind, v_bad;
  END IF;

  WITH incoming AS (
    SELECT x.v->>'netsuite_id' AS netsuite_id,
           btrim(x.v->>'name') AS name,
           nullif(x.v->>'parent_netsuite_id', '') AS parent_netsuite_id,
           coalesce((x.v->>'active')::boolean, true) AS active,
           coalesce(x.v->'details', '{}'::jsonb) AS details
    FROM jsonb_array_elements(p->'rows') AS x(v)
  ), written AS (
    INSERT INTO public.gl_netsuite_lists AS l (kind, netsuite_id, name, parent_netsuite_id, active, details)
    SELECT v_kind, i.netsuite_id, i.name, i.parent_netsuite_id, i.active, i.details
    FROM incoming i
    ON CONFLICT (kind, netsuite_id) DO UPDATE SET
      name = EXCLUDED.name,
      parent_netsuite_id = EXCLUDED.parent_netsuite_id,
      active = EXCLUDED.active,
      details = EXCLUDED.details,
      gone_at = NULL,
      changed_at = now()
    WHERE (l.name, l.parent_netsuite_id, l.active, l.details, l.gone_at)
      IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.parent_netsuite_id, EXCLUDED.active, EXCLUDED.details, NULL::timestamptz)
    RETURNING (xmax = 0) AS added
  )
  SELECT count(*) FILTER (WHERE added), count(*) FILTER (WHERE NOT added)
  INTO v_added, v_changed
  FROM written;

  RETURN jsonb_build_object('received', jsonb_array_length(p->'rows'), 'added', v_added, 'changed', v_changed);
END;
$$;

-- As migration 363 has it, with customers.
CREATE OR REPLACE FUNCTION public.gl_netsuite_lists_finish(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_kind TEXT := p->>'kind';
  v_listed INTEGER;
  v_here INTEGER;
  v_gone INTEGER := 0;
BEGIN
  IF v_kind IS NULL OR v_kind NOT IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item', 'customer') THEN
    RAISE EXCEPTION 'gl: unknown NetSuite list %', coalesce(v_kind, '(none)');
  END IF;
  IF jsonb_typeof(p->'netsuite_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: netsuite_ids must be a list';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_lists:' || v_kind));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_lists WHERE kind = v_kind AND gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_lists l SET gone_at = now()
  WHERE l.kind = v_kind
    AND l.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = l.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_invoices (
  -- NetSuite's internal id for the invoice FleetSuite made; its copy there is ledger_invoices 'CustInvc/<id>'.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The number NetSuite gave it. FleetSuite numbers its own invoices from 2027.
  netsuite_number TEXT,
  -- Which way FleetSuite made it: a vehicle off its sales order, a sales order's installed quantities, a PO's open
  -- quantities, scans, or a graphics job.
  made_from TEXT NOT NULL CHECK (made_from IN ('vehicle', 'sales_order', 'po', 'scans', 'graphics')),
  -- The FleetSuite record it billed: the check-in, the PO or the graphics job.
  made_from_id TEXT,
  sales_order_id TEXT CHECK (sales_order_id ~ '^[0-9]+$'),
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- The day FleetSuite made it, in Central time.
  invoice_date DATE NOT NULL,
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  -- 'sent': the location FleetSuite gave NetSuite; 'rule': FleetSuite's invoice location rule, for a sales order billed whole.
  location_from TEXT CHECK (location_from IN ('sent', 'rule')),
  po_number TEXT,
  memo TEXT,
  vin TEXT,
  terms_netsuite_id TEXT CHECK (terms_netsuite_id ~ '^[0-9]+$'),
  terms_name TEXT,
  terms_days INTEGER CHECK (terms_days >= 0),
  due_date DATE,
  -- How its sales tax was worked out (tax@1), on what basis, and at what rate (a fraction, 0 when not taxed).
  tax_rule TEXT NOT NULL CHECK (btrim(tax_rule) <> ''),
  tax_basis TEXT NOT NULL CHECK (tax_basis IN ('rate', 'exempt_customer', 'georgia')),
  tax_rate NUMERIC(9,6) NOT NULL CHECK (tax_rate >= 0 AND tax_rate < 1),
  subtotal NUMERIC(14,2) NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  total NUMERIC(14,2) NOT NULL,
  -- 'sent': the lines FleetSuite sent NetSuite; 'sales_order_copy': what was still to bill on FleetSuite's copy of the
  -- sales order, for one billed whole.
  lines_from TEXT NOT NULL CHECK (lines_from IN ('sent', 'sales_order_copy')),
  -- What FleetSuite couldn't work out: 'lines', 'customer', 'terms', 'prices', 'location'.
  unknowns TEXT[] NOT NULL DEFAULT '{}'
    CHECK (unknowns <@ ARRAY['lines', 'customer', 'terms', 'prices', 'location']::text[]),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total = subtotal + tax),
  CHECK (due_date IS NULL OR due_date >= invoice_date),
  CHECK (tax_basis = 'rate' OR (tax_rate = 0 AND tax = 0))
);
CREATE INDEX IF NOT EXISTS idx_gl_own_invoices_date ON gl_own_invoices(invoice_date DESC, netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_invoice_lines (
  invoice_id TEXT NOT NULL REFERENCES gl_own_invoices(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_netsuite_id TEXT CHECK (item_netsuite_id ~ '^-?[0-9]+$'),
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(16,4),
  rate NUMERIC(16,4),
  -- What the line charges, a discount negative.
  amount NUMERIC(14,2) NOT NULL,
  -- False when FleetSuite didn't know the line's price: NetSuite priced it.
  priced BOOLEAN NOT NULL DEFAULT true,
  taxable BOOLEAN NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  -- The sales order line it bills, for an invoice off a sales order.
  sales_order_line_id TEXT CHECK (sales_order_line_id ~ '^[0-9]+$'),
  PRIMARY KEY (invoice_id, line_no),
  CHECK (taxable OR tax = 0),
  CHECK (priced OR (amount = 0 AND tax = 0))
);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Saves FleetSuite's own copy of an invoice it just made. p:
--   { netsuite_id, netsuite_number?, company? ('BMG'), made_from, made_from_id?, sales_order_id?,
--     customer_netsuite_id?, customer_id?, invoice_date, location_netsuite_id?, location_from?, po_number?, memo?,
--     vin?, terms_netsuite_id?, terms_name?, terms_days?, due_date?, tax_rule, tax_basis, tax_rate, subtotal, tax,
--     total, lines_from, unknowns?, made_by?,
--     lines: [{ line_no, item_netsuite_id?, item_number?, description?, quantity?, rate?, amount, priced?, taxable,
--               tax, sales_order_line_id? }] }
-- Its lines must add up to its subtotal and tax. A copy of that invoice already saved stays as it is. Returns
-- { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_invoice_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_subtotal NUMERIC;
  v_tax NUMERIC;
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own invoice needs NetSuite''s id for the invoice';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(p->>'company', 'BMG');
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', 'BMG');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0), coalesce(sum((x.v->>'tax')::numeric), 0)
  INTO v_subtotal, v_tax
  FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_subtotal IS DISTINCT FROM (p->>'subtotal')::numeric OR v_tax IS DISTINCT FROM (p->>'tax')::numeric THEN
    RAISE EXCEPTION 'gl: own invoice %''s lines don''t add up to its subtotal and tax', v_id;
  END IF;

  INSERT INTO public.gl_own_invoices (
    netsuite_id, company_id, netsuite_number, made_from, made_from_id, sales_order_id, customer_netsuite_id,
    customer_id, invoice_date, location_netsuite_id, location_from, po_number, memo, vin, terms_netsuite_id,
    terms_name, terms_days, due_date, tax_rule, tax_basis, tax_rate, subtotal, tax, total, lines_from, unknowns,
    made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), p->>'made_from', nullif(p->>'made_from_id', ''),
    nullif(p->>'sales_order_id', ''), nullif(p->>'customer_netsuite_id', ''), nullif(p->>'customer_id', '')::uuid,
    (p->>'invoice_date')::date, nullif(p->>'location_netsuite_id', ''), nullif(p->>'location_from', ''),
    nullif(p->>'po_number', ''), nullif(p->>'memo', ''), nullif(p->>'vin', ''), nullif(p->>'terms_netsuite_id', ''),
    nullif(p->>'terms_name', ''), (p->>'terms_days')::integer, (p->>'due_date')::date, p->>'tax_rule',
    p->>'tax_basis', (p->>'tax_rate')::numeric, (p->>'subtotal')::numeric, (p->>'tax')::numeric,
    (p->>'total')::numeric, p->>'lines_from',
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'unknowns', '[]'::jsonb))), '{}'),
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_invoice_lines (
    invoice_id, line_no, item_netsuite_id, item_number, description, quantity, rate, amount, priced, taxable, tax,
    sales_order_line_id
  )
  SELECT v_id, x.line_no, nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''), nullif(x.description, ''),
         x.quantity, x.rate, x.amount, coalesce(x.priced, true), x.taxable, x.tax, nullif(x.sales_order_line_id, '')
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, item_netsuite_id TEXT, item_number TEXT, description TEXT, quantity NUMERIC, rate NUMERIC,
    amount NUMERIC, priced BOOLEAN, taxable BOOLEAN, tax NUMERIC, sales_order_line_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Readers ────────────────────────────────────────────────────────────────

-- FleetSuite's own invoices made from p_from to p_to, or only the one whose NetSuite id is p_netsuite_id, newest
-- first, each next to NetSuite's invoice:
--   invoices:  [{ own: the copy with its lines,
--                 netsuite: NetSuite's invoice as the ledger mirror copied it, with its lines (netamount: NetSuite's
--                           own, signed, a sale negative), or null before the mirror has it,
--                 netsuite_gl: { location_id } from its receivable line in the copy of NetSuite's general ledger, or
--                              null before that copy has it,
--                 customer_name, customer_list: NetSuite's customer as the lists copy has it }]
--   items:     { <NetSuite item id>: { number, type } } for the items on either side's lines
--   tax_codes: { <NetSuite tax code id>: { name, rate } } for NetSuite's tax lines
--   locations: { <NetSuite location id>: name }
--   terms:     { <NetSuite terms id>: { name, days } }
CREATE OR REPLACE FUNCTION public.gl_own_invoice_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*
    FROM public.gl_own_invoices o
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.invoice_date BETWEEN p_from AND p_to END
  ), twin AS (
    SELECT o.netsuite_id AS own_id, i.*
    FROM own o
    JOIN public.ledger_invoices i ON i.source = 'netsuite' AND i.external_id = 'CustInvc/' || o.netsuite_id
  )
  SELECT jsonb_build_object(
    'invoices', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'sales_order_id', o.sales_order_id,
          'customer_netsuite_id', o.customer_netsuite_id,
          'customer_id', o.customer_id,
          'date', to_char(o.invoice_date, 'YYYY-MM-DD'),
          'location_id', o.location_netsuite_id,
          'location_from', o.location_from,
          'po_number', o.po_number,
          'memo', o.memo,
          'vin', o.vin,
          'terms_id', o.terms_netsuite_id,
          'terms_name', o.terms_name,
          'terms_days', o.terms_days,
          'due_date', to_char(o.due_date, 'YYYY-MM-DD'),
          'tax_rule', o.tax_rule,
          'tax_basis', o.tax_basis,
          'tax_rate', o.tax_rate::text,
          'subtotal', o.subtotal::text,
          'tax', o.tax::text,
          'total', o.total::text,
          'lines_from', o.lines_from,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'quantity', l.quantity::text,
              'rate', l.rate::text,
              'amount', l.amount::text,
              'priced', l.priced,
              'taxable', l.taxable,
              'tax', l.tax::text,
              'sales_order_line_id', l.sales_order_line_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_invoice_lines l
            WHERE l.invoice_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.doc_number,
            'date', to_char(t.doc_date, 'YYYY-MM-DD'),
            'due_date', to_char(t.due_date, 'YYYY-MM-DD'),
            'total', t.total::text,
            'customer_netsuite_id', t.customer_netsuite_id,
            'customer_name', t.party_name,
            'po_number', t.po_number,
            'memo', t.memo,
            'status', t.status_label,
            'voided', t.voided,
            'deleted', t.deleted_at IS NOT NULL,
            'lines_copied', t.lines_synced_at IS NOT NULL,
            'changed_at', t.source_updated_at,
            'copied_at', t.last_synced_at,
            'lines', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'line_id', il.line_external_id,
                'line_no', il.line_no,
                'kind', il.line_kind,
                'item_id', il.item_external_id,
                'item_number', il.item_number,
                'description', il.description,
                'quantity', il.quantity::text,
                'rate', il.unit_price::text,
                'amount', il.amount::text,
                'netamount', il.raw->>'netamount'
              ) ORDER BY il.line_no NULLS LAST, il.line_external_id), '[]'::jsonb)
              FROM public.ledger_invoice_lines il
              WHERE il.document_id = t.id
            )
          )
          FROM twin t
          WHERE t.own_id = o.netsuite_id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object('location_id', g.location_id)
          FROM public.gl_netsuite_lines g WHERE g.transaction_id = o.netsuite_id AND g.line_id = '0'
        ),
        'customer_name', coalesce(
          (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = o.customer_id),
          (SELECT lc.display_name FROM public.ledger_customers lc
           WHERE lc.source = 'netsuite' AND lc.external_id = 'customer/' || o.customer_netsuite_id),
          (SELECT cl.name FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id)
        ),
        'customer_list', (
          SELECT cl.details FROM public.gl_netsuite_lists cl WHERE cl.kind = 'customer' AND cl.netsuite_id = o.customer_netsuite_id
        )
      ) ORDER BY o.invoice_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('number', l.name, 'type', l.details->>'item_type')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT ol.item_netsuite_id FROM public.gl_own_invoice_lines ol JOIN own o ON o.netsuite_id = ol.invoice_id
        UNION
        SELECT il.item_external_id FROM public.ledger_invoice_lines il JOIN twin t ON t.id = il.document_id
        WHERE il.line_kind <> 'tax'
      )
    ),
    'tax_codes', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object('name', l.name, 'rate', l.details->>'rate')), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'tax_code' AND l.netsuite_id IN (
        SELECT il.item_external_id FROM public.ledger_invoice_lines il JOIN twin t ON t.id = il.document_id
        WHERE il.line_kind = 'tax'
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ),
    'terms', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'name', l.name, 'days', (l.details->>'days_until_net_due')::numeric
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'term'
    )
  )
$$;

-- How many own invoices FleetSuite made each month, newest first: [{ month: 'YYYY-MM-01', invoices }].
CREATE OR REPLACE FUNCTION public.gl_own_invoice_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'invoices', m.invoices)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', invoice_date)::date AS month, count(*) AS invoices
    FROM public.gl_own_invoices
    GROUP BY 1
  ) m
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['gl_own_invoices', 'gl_own_invoice_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_lists_apply(jsonb)',
    'public.gl_netsuite_lists_finish(jsonb)',
    'public.gl_own_invoice_save(jsonb)',
    'public.gl_own_invoice_pairs(date, date, text)',
    'public.gl_own_invoice_months()'
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

COMMENT ON TABLE gl_netsuite_lists IS 'Migration 363: NetSuite''s locations, departments, classes, terms, tax codes, vendors and items as the books need them, and since migration 407 its customers, copied every two hours by src/lib/books/netsuite-lists.ts. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_lists.kind IS 'Which NetSuite list: location, department, class, term, tax_code (NetSuite''s sales tax items), vendor, item or customer.';
COMMENT ON COLUMN gl_netsuite_lists.details IS 'What else the list holds, by kind, keys present only when NetSuite gave a value. location: full_name, subsidiary_id. department, class: full_name. term: days_until_net_due, discount_percent, discount_days. tax_code: description, rate, tax_type, tax_agency_id. vendor: entity_id, expense_account, payables_account, terms_id. item: item_type, display_name, income_account, cogs_account, asset_account, expense_account. customer: entity_id, terms_id, taxable (T or F), tax_item_id. Accounts are NetSuite account ids (gl_accounts.netsuite_account_id).';
COMMENT ON TABLE gl_own_invoices IS 'Migration 407: FleetSuite''s own copy of each invoice it makes in NetSuite, worked out from what it billed by its own rules (src/lib/books/own-invoices.ts), saved only by gl_own_invoice_save, by NetSuite''s id for the invoice. Not posted to the books yet. Service-role write and read.';
COMMENT ON TABLE gl_own_invoice_lines IS 'Migration 407: the lines of FleetSuite''s own invoices (gl_own_invoices), in the order billed, each with its sales tax. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_invoice_save(jsonb) IS 'Migration 407: saves FleetSuite''s own copy of an invoice it just made, refusing one whose lines don''t add up; one already saved stays as it is. Service role only.';
COMMENT ON FUNCTION public.gl_own_invoice_pairs(date, date, text) IS 'Migration 407: FleetSuite''s own invoices made on some days, or one, each next to NetSuite''s invoice as the ledger mirror copied it, with the names the pages show, for FleetSuite''s own invoices and the daily check. Service role only.';
COMMENT ON FUNCTION public.gl_own_invoice_months() IS 'Migration 407: how many own invoices FleetSuite made each month. Service role only.';
