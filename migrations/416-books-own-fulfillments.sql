-- Migration 416: FleetSuite's own books, part 25 — FleetSuite's own copy of
-- each fulfillment it makes, next to NetSuite's, with what FleetSuite works
-- out it cost.
--
-- Owner decision 2026-10-19 (thread "Replacing NetSuite with FleetSuite",
-- "Fulfillments"): FleetSuite fulfils a sales order before it invoices it
-- (src/lib/netsuite.ts fulfillSalesOrder). From now on it keeps its own copy
-- of each fulfillment it makes: what it takes from stock, from where and on
-- what day, worked out from its copy of the sales order
-- (src/lib/books/own-fulfillments.ts, docs/books.md "FleetSuite's own
-- fulfillments"). Its cost FleetSuite works out itself, from its own count
-- and value of each item at each location (stock by item, migrations
-- 401–405), and each copy is put next to NetSuite's fulfillment, so wherever
-- FleetSuite would cost a fulfillment differently shows up before FleetSuite
-- costs them on its own. Posting the copies to the books comes after.
--   * gl_own_fulfillments and gl_own_fulfillment_lines, the copies, written
--     only by gl_own_fulfillment_save; saving the same NetSuite fulfillment
--     again changes nothing;
--   * gl_own_fulfillment_pairs(from, to, netsuite_id), the copies made on
--     those days, or the one, each with NetSuite's fulfillment as the copy
--     of its stock moves has it (migration 401), each line's value from the
--     copy of NetSuite's general ledger (migration 361), the count and value
--     FleetSuite had of each item at each location either side names just
--     before the fulfillment, and the names the pages show;
--   * gl_own_fulfillment_months(), how many copies were made each month.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_fulfillments (
  -- NetSuite's internal id for the item fulfillment FleetSuite made.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The number NetSuite gave it.
  netsuite_number TEXT,
  -- Which way FleetSuite invoiced the order it fulfilled: a finished vehicle, or a sales order's installed quantities.
  made_from TEXT NOT NULL CHECK (made_from IN ('vehicle', 'sales_order')),
  -- The FleetSuite record it was invoicing: the check-in or the PO.
  made_from_id TEXT,
  sales_order_id TEXT NOT NULL CHECK (sales_order_id ~ '^[0-9]+$'),
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  -- The day FleetSuite made it, in Central time.
  fulfil_date DATE NOT NULL,
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  -- 'po_rule': where FleetSuite's PO location rule books the PO's invoice; 'customer_rule': where its invoice
  -- location rule books the customer's.
  location_from TEXT CHECK (location_from IN ('po_rule', 'customer_rule')),
  -- What FleetSuite couldn't work out: 'lines' (its copy of the sales order didn't have the order), 'location'.
  unknowns TEXT[] NOT NULL DEFAULT '{}'
    CHECK (unknowns <@ ARRAY['lines', 'location']::text[]),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((location_netsuite_id IS NULL) = (location_from IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_gl_own_fulfillments_date ON gl_own_fulfillments(fulfil_date DESC, netsuite_id);
CREATE INDEX IF NOT EXISTS idx_gl_own_fulfillments_order ON gl_own_fulfillments(sales_order_id);

CREATE TABLE IF NOT EXISTS gl_own_fulfillment_lines (
  fulfillment_id TEXT NOT NULL REFERENCES gl_own_fulfillments(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_netsuite_id TEXT NOT NULL CHECK (item_netsuite_id ~ '^[0-9]+$'),
  item_number TEXT,
  description TEXT,
  -- NetSuite's type for the item as the lists copy had it: kept in stock ('InvtPart', 'Assembly'), a kit of parts
  -- FleetSuite doesn't know ('Kit'), or null when the lists copy didn't have the item.
  item_type TEXT CHECK (item_type IN ('InvtPart', 'Assembly', 'Kit')),
  quantity NUMERIC(16,4) NOT NULL CHECK (quantity > 0),
  -- The sales order line it fulfils.
  sales_order_line_id TEXT CHECK (sales_order_line_id ~ '^[0-9]+$'),
  PRIMARY KEY (fulfillment_id, line_no)
);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Saves FleetSuite's own copy of a fulfillment it just made. p:
--   { netsuite_id, netsuite_number?, company? ('BMG'), made_from, made_from_id?, sales_order_id,
--     customer_netsuite_id?, fulfil_date, location_netsuite_id?, location_from?, unknowns?, made_by?,
--     lines: [{ line_no, item_netsuite_id, item_number?, description?, item_type?, quantity, sales_order_line_id? }] }
-- A copy of that fulfillment already saved stays as it is. Returns { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_fulfillment_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own fulfillment needs NetSuite''s id for the fulfillment';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(p->>'company', 'BMG');
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', 'BMG');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;

  INSERT INTO public.gl_own_fulfillments (
    netsuite_id, company_id, netsuite_number, made_from, made_from_id, sales_order_id, customer_netsuite_id,
    fulfil_date, location_netsuite_id, location_from, unknowns, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), p->>'made_from', nullif(p->>'made_from_id', ''),
    p->>'sales_order_id', nullif(p->>'customer_netsuite_id', ''), (p->>'fulfil_date')::date,
    nullif(p->>'location_netsuite_id', ''), nullif(p->>'location_from', ''),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'unknowns', '[]'::jsonb))), '{}'),
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_fulfillment_lines (
    fulfillment_id, line_no, item_netsuite_id, item_number, description, item_type, quantity, sales_order_line_id
  )
  SELECT v_id, x.line_no, x.item_netsuite_id, nullif(x.item_number, ''), nullif(x.description, ''),
         nullif(x.item_type, ''), x.quantity, nullif(x.sales_order_line_id, '')
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, item_netsuite_id TEXT, item_number TEXT, description TEXT, item_type TEXT, quantity NUMERIC,
    sales_order_line_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Readers ────────────────────────────────────────────────────────────────

-- FleetSuite's own fulfillments made from p_from to p_to, or only the one whose NetSuite id is p_netsuite_id, newest
-- first, each next to NetSuite's fulfillment:
--   fulfillments: [{ own: the copy with its lines,
--                    netsuite: NetSuite's fulfillment as the copy of its stock moves has it (migration 401), with
--                              each line that names an item: its location, quantity (signed, stock out negative),
--                              whether it moves stock, and its value, what NetSuite posted to an inventory account
--                              on it in the copy of NetSuite's general ledger (debit positive; null when that copy
--                              has nothing on the line); null before the stock copy has it,
--                    netsuite_gl: { posting_month, entry: what it posted to each account } once the copy of
--                                 NetSuite's general ledger has it, else null,
--                    before: [{ item_id, location_id, quantity, value }] what FleetSuite counted of each item at
--                            each location either side names just before the fulfillment, as stock by item counts
--                            and values (migrations 401 and 402): its count and value on December 31, 2024 and
--                            every document since that comes before it, by date and then NetSuite's id,
--                    sales_order: { number, customer_name } from FleetSuite's copy of the sales order,
--                    invoice: { netsuite_id, number } FleetSuite's own invoice off the order made since, if any }]
--   items:     { <NetSuite item id>: { number, type, display_name } } for the items on either side
--   locations: { <NetSuite location id>: name }
--   accounts:  { <NetSuite account id>: { number, name } } for the accounts NetSuite's fulfillments posted to
-- Quantities and amounts are decimal strings.
CREATE OR REPLACE FUNCTION public.gl_own_fulfillment_pairs(p_from DATE, p_to DATE, p_netsuite_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*
    FROM public.gl_own_fulfillments o
    WHERE CASE WHEN p_netsuite_id IS NOT NULL THEN o.netsuite_id = p_netsuite_id
               ELSE o.fulfil_date BETWEEN p_from AND p_to END
  ),
  stocked AS (
    -- The items NetSuite keeps in stock (bill-rule.ts STOCK_TYPES); only they have a value, as in gl_stock_items.
    SELECT i.netsuite_id AS item_id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND i.details->>'item_type' IN ('InvtPart', 'Assembly')
  ),
  asset_accounts AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  twin AS (
    SELECT o.netsuite_id AS own_id, d.*
    FROM own o
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = o.netsuite_id
  ),
  twin_lines AS (
    SELECT t.own_id, s.line_id, s.company_id, s.item_id, s.location_id, s.quantity, s.moves_stock,
           (SELECT sum(l.debit - l.credit)
            FROM public.gl_netsuite_lines l
            WHERE l.transaction_id = s.document_id AND l.line_id = s.line_id
              AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)) AS value
    FROM twin t
    JOIN public.gl_netsuite_stock_lines s ON s.document_id = t.netsuite_id
  ),
  places AS (
    -- Each item at each location either side names: the copy's at its location, NetSuite's where it moved stock.
    SELECT o.netsuite_id AS own_id, o.company_id, o.fulfil_date, ol.item_netsuite_id AS item_id,
           o.location_netsuite_id AS location_id
    FROM own o
    JOIN public.gl_own_fulfillment_lines ol ON ol.fulfillment_id = o.netsuite_id
    WHERE o.location_netsuite_id IS NOT NULL
    UNION
    SELECT o.netsuite_id, o.company_id, o.fulfil_date, tl.item_id, tl.location_id
    FROM own o
    JOIN twin_lines tl ON tl.own_id = o.netsuite_id AND tl.company_id = o.company_id
    WHERE tl.moves_stock
  ),
  before AS (
    SELECT p.own_id, p.item_id, p.location_id,
           coalesce(op.quantity, 0) + coalesce(mv.quantity, 0) AS quantity,
           CASE WHEN p.item_id IN (SELECT item_id FROM stocked) THEN coalesce(op.value, 0) + coalesce(vl.value, 0) ELSE 0 END AS value
    FROM places p
    LEFT JOIN public.gl_netsuite_stock_opening op
      ON op.company_id = p.company_id AND op.item_id = p.item_id AND op.location_id IS NOT DISTINCT FROM p.location_id
    LEFT JOIN LATERAL (
      SELECT sum(s.quantity) AS quantity
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      WHERE s.item_id = p.item_id AND s.company_id = p.company_id AND s.location_id IS NOT DISTINCT FROM p.location_id
        AND s.moves_stock AND d.gone_at IS NULL
        AND (d.trandate, d.netsuite_id::bigint) < (p.fulfil_date, p.own_id::bigint)
    ) mv ON true
    LEFT JOIN LATERAL (
      SELECT sum(l.debit - l.credit) AS value
      FROM public.gl_netsuite_stock_lines s
      JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
      JOIN public.gl_netsuite_lines l ON l.transaction_id = s.document_id AND l.line_id = s.line_id
      WHERE s.item_id = p.item_id AND s.company_id = p.company_id AND s.location_id IS NOT DISTINCT FROM p.location_id
        AND d.gone_at IS NULL
        AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        AND (d.trandate, d.netsuite_id::bigint) < (p.fulfil_date, p.own_id::bigint)
    ) vl ON true
  )
  SELECT jsonb_build_object(
    'fulfillments', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'made_from', o.made_from,
          'made_from_id', o.made_from_id,
          'sales_order_id', o.sales_order_id,
          'customer_netsuite_id', o.customer_netsuite_id,
          'date', to_char(o.fulfil_date, 'YYYY-MM-DD'),
          'location_id', o.location_netsuite_id,
          'location_from', o.location_from,
          'unknowns', to_jsonb(o.unknowns),
          'made_at', o.made_at,
          'lines', (
            SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_no', l.line_no,
              'item_id', l.item_netsuite_id,
              'item_number', l.item_number,
              'description', l.description,
              'item_type', l.item_type,
              'quantity', l.quantity::text,
              'sales_order_line_id', l.sales_order_line_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_fulfillment_lines l
            WHERE l.fulfillment_id = o.netsuite_id
          )
        ),
        'netsuite', (
          SELECT jsonb_build_object(
            'number', t.tranid,
            'type', t.tran_type,
            'date', to_char(t.trandate, 'YYYY-MM-DD'),
            'gone', t.gone_at IS NOT NULL,
            'lines', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'line_id', tl.line_id,
                'item_id', tl.item_id,
                'location_id', tl.location_id,
                'quantity', tl.quantity::text,
                'moves_stock', tl.moves_stock,
                'value', tl.value::text
              ) ORDER BY tl.line_id::bigint), '[]'::jsonb)
              FROM twin_lines tl
              WHERE tl.own_id = o.netsuite_id AND tl.company_id = o.company_id
            )
          )
          FROM twin t
          WHERE t.own_id = o.netsuite_id
        ),
        'netsuite_gl', (
          SELECT jsonb_build_object(
            'posting_month', to_char(g.posting_month, 'YYYY-MM-DD'),
            'entry', (
              SELECT coalesce(jsonb_agg(jsonb_build_object(
                'account_id', e.account_id, 'debit', e.debit::text, 'credit', e.credit::text
              ) ORDER BY e.account_id::bigint), '[]'::jsonb)
              FROM (
                SELECT l.netsuite_account_id AS account_id, sum(l.debit) AS debit, sum(l.credit) AS credit
                FROM public.gl_netsuite_lines l
                WHERE l.transaction_id = o.netsuite_id AND l.company_id = o.company_id
                GROUP BY l.netsuite_account_id
              ) e
            )
          )
          FROM public.gl_netsuite_transactions g
          WHERE g.netsuite_id = o.netsuite_id
        ),
        'before', (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'item_id', b.item_id, 'location_id', b.location_id, 'quantity', b.quantity::text, 'value', b.value::text
          ) ORDER BY b.item_id::bigint, b.location_id NULLS FIRST), '[]'::jsonb)
          FROM before b
          WHERE b.own_id = o.netsuite_id
        ),
        'sales_order', (
          SELECT jsonb_build_object('number', so.tranid, 'customer_name', so.customer_name)
          FROM public.netsuite_sales_orders so
          WHERE so.netsuite_id = o.sales_order_id
        ),
        'invoice', (
          SELECT jsonb_build_object('netsuite_id', i.netsuite_id, 'number', i.netsuite_number)
          FROM public.gl_own_invoices i
          WHERE i.sales_order_id = o.sales_order_id AND i.made_at >= o.made_at
          ORDER BY i.made_at, i.netsuite_id::bigint
          LIMIT 1
        )
      ) ORDER BY o.fulfil_date DESC, o.netsuite_id::bigint DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, jsonb_build_object(
        'number', l.name, 'type', l.details->>'item_type', 'display_name', l.details->>'display_name'
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'item' AND l.netsuite_id IN (
        SELECT ol.item_netsuite_id FROM public.gl_own_fulfillment_lines ol JOIN own o ON o.netsuite_id = ol.fulfillment_id
        UNION
        SELECT tl.item_id FROM twin_lines tl
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ),
    'accounts', (
      SELECT coalesce(jsonb_object_agg(a.netsuite_account_id, jsonb_build_object('number', a.number, 'name', a.name)), '{}'::jsonb)
      FROM public.gl_accounts a
      WHERE a.netsuite_account_id IN (
        SELECT l.netsuite_account_id FROM public.gl_netsuite_lines l JOIN own o ON o.netsuite_id = l.transaction_id
      )
    )
  )
$$;

-- How many own fulfillments FleetSuite made each month, newest first: [{ month: 'YYYY-MM-01', fulfillments }].
CREATE OR REPLACE FUNCTION public.gl_own_fulfillment_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'fulfillments', m.fulfillments)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', fulfil_date)::date AS month, count(*) AS fulfillments
    FROM public.gl_own_fulfillments
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
  FOREACH t IN ARRAY ARRAY['gl_own_fulfillments', 'gl_own_fulfillment_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_own_fulfillment_save(jsonb)',
    'public.gl_own_fulfillment_pairs(date, date, text)',
    'public.gl_own_fulfillment_months()'
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

COMMENT ON TABLE gl_own_fulfillments IS 'Migration 416: FleetSuite''s own copy of each fulfillment it makes in NetSuite before invoicing a sales order, worked out from its copy of the order (src/lib/books/own-fulfillments.ts), saved only by gl_own_fulfillment_save, by NetSuite''s id for the fulfillment. Its cost is worked out from stock by item when it''s checked. Not posted to the books yet. Service-role write and read.';
COMMENT ON TABLE gl_own_fulfillment_lines IS 'Migration 416: what each of FleetSuite''s own fulfillments (gl_own_fulfillments) takes from stock, item by item, in the sales order''s order. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_fulfillment_save(jsonb) IS 'Migration 416: saves FleetSuite''s own copy of a fulfillment it just made; one already saved stays as it is. Service role only.';
COMMENT ON FUNCTION public.gl_own_fulfillment_pairs(date, date, text) IS 'Migration 416: FleetSuite''s own fulfillments made on some days, or one, each next to NetSuite''s fulfillment as the copies of its stock moves and general ledger have it, with FleetSuite''s count and value of each item named just before it, for FleetSuite''s own fulfillments and the daily check. Service role only.';
COMMENT ON FUNCTION public.gl_own_fulfillment_months() IS 'Migration 416: how many own fulfillments FleetSuite made each month. Service role only.';
