-- Migration 401: FleetSuite's own books, part 21 — stock by item.
--
-- Owner decision 2026-10-18 (thread "Replacing NetSuite with FleetSuite",
-- "Stock by item", "Every move"): FleetSuite keeps each item's count and
-- value at each location itself, from a copy of every NetSuite document that
-- moves stock since January 1, 2025, and checks it against NetSuite's own
-- count every day (src/lib/books/netsuite-stock.ts, stock-items.ts,
-- docs/books.md "Stock by item"). Until now FleetSuite only knew each item's
-- company-wide count, copied from NetSuite onto the parts catalog, with no
-- location, cost or history.
--
-- What's copied, every two hours (/api/cron/books-netsuite-stock at :43 on
-- odd hours, and "Copy now" on the Stock by item page):
--   * every NetSuite document dated from 2025 with a line that moves stock
--     (transactionline.isinventoryaffecting): fulfillments, receipts,
--     adjustments, transfers, builds and unbuilds, and invoices and credit
--     memos that move stock themselves, each with all of its lines that name
--     an item, for BMG and 1084: the line's item, location, quantity and
--     whether it moves stock. A line that names an item without moving it
--     (a cost of goods line, say) is kept so its cost can be told apart;
--   * each item's count and value at each location on December 31, 2024,
--     from NetSuite's own lines before 2025: where the count starts;
--   * NetSuite's own count (and value, when it gives one) of each item at
--     each location now, or of each item company-wide when it won't say
--     where: what the count is checked against.
-- An item's count is its starting count plus the quantity of every line of
-- it that moves stock. Its value is its starting value plus what NetSuite
-- posted to an inventory account on its lines, read from the copy of
-- NetSuite's general ledger (migration 361) by NetSuite's line id, so a cost
-- NetSuite works out again later shows here with the GL copy. The inventory
-- accounts are the ones NetSuite's items name (gl_netsuite_lists, migration
-- 363).
--
-- Like the other copies of NetSuite's documents, nothing is written back,
-- and a document is never deleted: gone_at records when NetSuite stopped
-- listing it, and it comes back if NetSuite lists it again.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_netsuite_stock_documents (
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  tran_type TEXT NOT NULL CHECK (btrim(tran_type) <> ''),
  tranid TEXT,
  trandate DATE NOT NULL,
  content_hash TEXT NOT NULL,
  gone_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_stock_documents_date ON gl_netsuite_stock_documents(trandate);

CREATE TABLE IF NOT EXISTS gl_netsuite_stock_lines (
  document_id TEXT NOT NULL REFERENCES gl_netsuite_stock_documents(netsuite_id) ON DELETE CASCADE,
  line_id TEXT NOT NULL CHECK (line_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL CHECK (item_id ~ '^[0-9]+$'),
  location_id TEXT CHECK (location_id ~ '^[0-9]+$'),
  quantity NUMERIC NOT NULL DEFAULT 0,
  moves_stock BOOLEAN NOT NULL,
  PRIMARY KEY (document_id, line_id)
);
CREATE INDEX IF NOT EXISTS idx_gl_netsuite_stock_lines_item ON gl_netsuite_stock_lines(item_id);

CREATE TABLE IF NOT EXISTS gl_netsuite_stock_opening (
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  item_id TEXT NOT NULL CHECK (item_id ~ '^[0-9]+$'),
  location_id TEXT CHECK (location_id ~ '^[0-9]+$'),
  quantity NUMERIC NOT NULL DEFAULT 0,
  value NUMERIC(18,2) NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_netsuite_stock_opening_key
  ON gl_netsuite_stock_opening(company_id, item_id, coalesce(location_id, ''));

CREATE TABLE IF NOT EXISTS gl_netsuite_stock_counts (
  item_id TEXT NOT NULL CHECK (item_id ~ '^[0-9]+$'),
  location_id TEXT CHECK (location_id ~ '^[0-9]+$'),
  quantity NUMERIC NOT NULL,
  value NUMERIC(18,2),
  read_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gl_netsuite_stock_counts_key
  ON gl_netsuite_stock_counts(item_id, coalesce(location_id, ''));

-- ── Writes ─────────────────────────────────────────────────────────────────

-- Applies one page of NetSuite documents that move stock. p:
--   { documents: [{ netsuite_id, tran_type, tranid?, trandate,
--                   lines: [{ line_id, company, item_id, location_id?, quantity, moves_stock }] }] }
-- A new document is added. One whose content differs, or that had gone from
-- NetSuite, has its lines replaced; an unchanged one is left alone. The
-- whole page applies or none of it does. Returns
-- { received, added, changed, unchanged, lines }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_stock_apply(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_doc JSONB;
  v_line JSONB;
  v_id TEXT;
  v_hash TEXT;
  v_stored TEXT;
  v_gone TIMESTAMPTZ;
  v_found BOOLEAN;
  v_company UUID;
  v_companies JSONB;
  v_bad TEXT;
  v_added INTEGER := 0;
  v_changed INTEGER := 0;
  v_unchanged INTEGER := 0;
  v_lines INTEGER := 0;
BEGIN
  IF jsonb_typeof(p->'documents') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: documents must be a list';
  END IF;
  -- One writer at a time: the cron and "Copy now" can land together.
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_stock'));

  SELECT x.v->>'netsuite_id' INTO v_bad
  FROM jsonb_array_elements(p->'documents') AS x(v)
  GROUP BY x.v->>'netsuite_id'
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: NetSuite document % is in the page twice', v_bad;
  END IF;

  SELECT jsonb_object_agg(code, id) INTO v_companies FROM public.gl_companies;

  FOR v_doc IN SELECT value FROM jsonb_array_elements(p->'documents') LOOP
    v_id := v_doc->>'netsuite_id';
    IF coalesce(v_id, '') !~ '^[0-9]+$' THEN
      RAISE EXCEPTION 'gl: NetSuite id "%" isn''t a number', coalesce(v_id, '(none)');
    END IF;
    IF coalesce(btrim(v_doc->>'tran_type'), '') = '' THEN
      RAISE EXCEPTION 'gl: NetSuite document % has no type', v_id;
    END IF;
    IF coalesce(v_doc->>'trandate', '') !~ '^\d{4}-\d{2}-\d{2}$' THEN
      RAISE EXCEPTION 'gl: NetSuite document % has no date', v_id;
    END IF;
    IF jsonb_typeof(v_doc->'lines') IS DISTINCT FROM 'array' OR jsonb_array_length(v_doc->'lines') = 0 THEN
      RAISE EXCEPTION 'gl: NetSuite document % has no lines', v_id;
    END IF;
    SELECT x.v->>'line_id' INTO v_bad
    FROM jsonb_array_elements(v_doc->'lines') AS x(v)
    GROUP BY x.v->>'line_id'
    HAVING count(*) > 1
    LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'gl: line % of NetSuite document % is in the page twice', v_bad, v_id;
    END IF;

    v_hash := md5(v_doc::text);
    SELECT content_hash, gone_at INTO v_stored, v_gone
    FROM public.gl_netsuite_stock_documents WHERE netsuite_id = v_id FOR UPDATE;
    v_found := FOUND;
    IF v_found AND v_stored = v_hash AND v_gone IS NULL THEN
      v_unchanged := v_unchanged + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.gl_netsuite_stock_documents (netsuite_id, tran_type, tranid, trandate, content_hash)
    VALUES (v_id, btrim(v_doc->>'tran_type'), nullif(btrim(v_doc->>'tranid'), ''), (v_doc->>'trandate')::date, v_hash)
    ON CONFLICT (netsuite_id) DO UPDATE SET
      tran_type = EXCLUDED.tran_type,
      tranid = EXCLUDED.tranid,
      trandate = EXCLUDED.trandate,
      content_hash = EXCLUDED.content_hash,
      gone_at = NULL,
      changed_at = now();

    DELETE FROM public.gl_netsuite_stock_lines WHERE document_id = v_id;
    FOR v_line IN SELECT value FROM jsonb_array_elements(v_doc->'lines') LOOP
      IF coalesce(v_line->>'line_id', '') !~ '^[0-9]+$' OR coalesce(v_line->>'item_id', '') !~ '^[0-9]+$'
         OR coalesce(v_line->>'location_id', '') !~ '^[0-9]*$' THEN
        RAISE EXCEPTION 'gl: a line of NetSuite document % has no line, item or location id FleetSuite can read', v_id;
      END IF;
      IF coalesce(v_line->>'quantity', '') !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
        RAISE EXCEPTION 'gl: line % of NetSuite document % has a quantity FleetSuite can''t read', v_line->>'line_id', v_id;
      END IF;
      IF jsonb_typeof(v_line->'moves_stock') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'gl: line % of NetSuite document % doesn''t say whether it moves stock', v_line->>'line_id', v_id;
      END IF;
      v_company := (v_companies->>(v_line->>'company'))::uuid;
      IF v_company IS NULL THEN
        RAISE EXCEPTION 'gl: unknown company % on NetSuite document %', v_line->>'company', v_id;
      END IF;
      INSERT INTO public.gl_netsuite_stock_lines (document_id, line_id, company_id, item_id, location_id, quantity, moves_stock)
      VALUES (
        v_id, v_line->>'line_id', v_company, v_line->>'item_id', nullif(v_line->>'location_id', ''),
        (v_line->>'quantity')::numeric, (v_line->>'moves_stock')::boolean
      );
      v_lines := v_lines + 1;
    END LOOP;
    IF v_found THEN v_changed := v_changed + 1; ELSE v_added := v_added + 1; END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'received', jsonb_array_length(p->'documents'), 'added', v_added, 'changed', v_changed,
    'unchanged', v_unchanged, 'lines', v_lines
  );
END;
$$;

-- Once a run has read the id of every NetSuite document dated from 2025
-- that moves stock, marks the ones NetSuite no longer lists as gone. A read
-- that looks cut short (none, or under half of the documents still here)
-- marks nothing and says so. p: { netsuite_ids: [every id NetSuite listed] }.
-- Returns { listed, here, gone, cut_short }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_stock_finish(p JSONB)
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
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_stock'));

  SELECT count(DISTINCT x.id) INTO v_listed FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id);
  SELECT count(*) INTO v_here FROM public.gl_netsuite_stock_documents WHERE gone_at IS NULL;
  IF v_here > 0 AND (v_listed = 0 OR v_listed * 2 < v_here) THEN
    RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', 0, 'cut_short', true);
  END IF;

  WITH listed AS (
    SELECT DISTINCT x.id FROM jsonb_array_elements_text(p->'netsuite_ids') AS x(id)
  )
  UPDATE public.gl_netsuite_stock_documents d SET gone_at = now()
  WHERE d.gone_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM listed s WHERE s.id = d.netsuite_id);
  GET DIAGNOSTICS v_gone = ROW_COUNT;

  RETURN jsonb_build_object('listed', v_listed, 'here', v_here, 'gone', v_gone, 'cut_short', false);
END;
$$;

-- Replaces where each item's count starts: its count and value at each
-- location on December 31, 2024, from NetSuite's own lines before 2025. p:
--   { rows: [{ company, item_id, location_id?, quantity, value }] }
-- Refused whole if a row names a company that doesn't exist, or an item and
-- location twice. Returns { rows }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_stock_store_opening(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: rows must be a list';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_stock'));
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'rows') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'gl: a starting count names a company that doesn''t exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'rows') AS x(item_id TEXT, location_id TEXT, quantity TEXT, value TEXT)
    WHERE coalesce(x.item_id, '') !~ '^[0-9]+$' OR coalesce(x.location_id, '') !~ '^[0-9]*$'
       OR coalesce(x.quantity, '') !~ '^-?[0-9]+(\.[0-9]+)?$' OR coalesce(x.value, '') !~ '^-?[0-9]+(\.[0-9]{1,2})?$'
  ) THEN
    RAISE EXCEPTION 'gl: a starting count has an item, location, quantity or value FleetSuite can''t read';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'rows') AS x(company TEXT, item_id TEXT, location_id TEXT)
    GROUP BY x.company, x.item_id, coalesce(x.location_id, '') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'gl: a starting count names an item and location twice';
  END IF;

  DELETE FROM public.gl_netsuite_stock_opening WHERE true;
  INSERT INTO public.gl_netsuite_stock_opening (company_id, item_id, location_id, quantity, value)
  SELECT c.id, x.item_id, nullif(x.location_id, ''), x.quantity::numeric, x.value::numeric
  FROM jsonb_to_recordset(p->'rows') AS x(company TEXT, item_id TEXT, location_id TEXT, quantity TEXT, value TEXT)
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_rows);
END;
$$;

-- Replaces NetSuite's own count of each item at each location (location_id
-- left out when NetSuite only gives each item's company-wide count), with
-- its value when NetSuite gives one. p:
--   { rows: [{ item_id, location_id?, quantity, value? }] }
-- Refused whole if a row is unreadable or names an item and location twice.
-- Returns { rows }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_stock_store_counts(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_rows INTEGER;
BEGIN
  IF jsonb_typeof(p->'rows') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: rows must be a list';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_netsuite_stock'));
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'rows') AS x(item_id TEXT, location_id TEXT, quantity TEXT, value TEXT)
    WHERE coalesce(x.item_id, '') !~ '^[0-9]+$' OR coalesce(x.location_id, '') !~ '^[0-9]*$'
       OR coalesce(x.quantity, '') !~ '^-?[0-9]+(\.[0-9]+)?$'
       OR (x.value IS NOT NULL AND x.value !~ '^-?[0-9]+(\.[0-9]{1,2})?$')
  ) THEN
    RAISE EXCEPTION 'gl: a NetSuite count has an item, location, quantity or value FleetSuite can''t read';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'rows') AS x(item_id TEXT, location_id TEXT)
    GROUP BY x.item_id, coalesce(x.location_id, '') HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'gl: NetSuite''s counts name an item and location twice';
  END IF;

  DELETE FROM public.gl_netsuite_stock_counts WHERE true;
  INSERT INTO public.gl_netsuite_stock_counts (item_id, location_id, quantity, value, read_at)
  SELECT x.item_id, nullif(x.location_id, ''), x.quantity::numeric, x.value::numeric, now()
  FROM jsonb_to_recordset(p->'rows') AS x(item_id TEXT, location_id TEXT, quantity TEXT, value TEXT);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN jsonb_build_object('rows', v_rows);
END;
$$;

-- ── Reads ──────────────────────────────────────────────────────────────────

-- The inventory accounts: the ones NetSuite's items name as their asset
-- account in the copy of NetSuite's lists (migration 363), as NetSuite ids.
-- The copy reads each item's starting value from these.
CREATE OR REPLACE FUNCTION public.gl_stock_inventory_accounts()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(a.id ORDER BY a.id::bigint), '[]'::jsonb)
  FROM (
    SELECT DISTINCT i.details->>'asset_account' AS id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND coalesce(i.details->>'asset_account', '') ~ '^[0-9]+$'
  ) a
$$;

-- Every item FleetSuite counts, at each location, for every company, next to
-- NetSuite's own counts (src/lib/books/stock-items.ts compares them):
--   rows      per company, item and location: the starting count and value
--             (December 31, 2024), the count and value now (the start plus
--             every copied line that moves stock, and what NetSuite posted to
--             an inventory account on the item's lines), how many documents
--             moved it and the latest one's date;
--   netsuite  NetSuite's own counts as last read (location_id null when
--             NetSuite gave each item's company-wide count), and when;
--   items     the names of the items either side has, from the copy of
--             NetSuite's items (migration 363);
--   locations every location in that copy, with its subsidiary;
--   ledger    per company, what the copy of NetSuite's general ledger holds
--             on the inventory accounts: its starting balance plus every line
--             since, so the items' value can be put next to it;
--   accounts  the inventory accounts: the ones NetSuite's items name.
-- Quantities and amounts are decimal strings, debit positive.
CREATE OR REPLACE FUNCTION public.gl_stock_items()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH asset_accounts AS (
    SELECT DISTINCT i.details->>'asset_account' AS id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND coalesce(i.details->>'asset_account', '') ~ '^[0-9]+$'
  ),
  live AS (
    SELECT s.document_id, s.line_id, s.company_id, s.item_id, s.location_id, s.quantity, s.moves_stock, d.trandate
    FROM public.gl_netsuite_stock_lines s
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
    WHERE d.gone_at IS NULL
  ),
  moved AS (
    SELECT company_id, item_id, location_id, sum(quantity) AS quantity,
           count(DISTINCT document_id) AS documents, max(trandate) AS last_date
    FROM live
    WHERE moves_stock
    GROUP BY company_id, item_id, location_id
  ),
  valued AS (
    SELECT s.company_id, s.item_id, s.location_id, sum(l.debit - l.credit) AS value
    FROM public.gl_netsuite_lines l
    JOIN live s ON s.document_id = l.transaction_id AND s.line_id = l.line_id
    WHERE l.netsuite_account_id IN (SELECT id FROM asset_accounts)
    GROUP BY s.company_id, s.item_id, s.location_id
  ),
  keyed AS (
    SELECT company_id, item_id, location_id FROM public.gl_netsuite_stock_opening
    UNION
    SELECT company_id, item_id, location_id FROM moved
    UNION
    SELECT company_id, item_id, location_id FROM valued
  ),
  counted AS (
    SELECT c.code AS company, k.item_id, k.location_id,
           coalesce(o.quantity, 0) AS opening_quantity, coalesce(o.value, 0) AS opening_value,
           coalesce(o.quantity, 0) + coalesce(m.quantity, 0) AS quantity,
           coalesce(o.value, 0) + coalesce(v.value, 0) AS value,
           coalesce(m.documents, 0) AS documents, m.last_date
    FROM keyed k
    JOIN public.gl_companies c ON c.id = k.company_id
    LEFT JOIN public.gl_netsuite_stock_opening o
      ON o.company_id = k.company_id AND o.item_id = k.item_id AND o.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN moved m
      ON m.company_id = k.company_id AND m.item_id = k.item_id AND m.location_id IS NOT DISTINCT FROM k.location_id
    LEFT JOIN valued v
      ON v.company_id = k.company_id AND v.item_id = k.item_id AND v.location_id IS NOT DISTINCT FROM k.location_id
  ),
  named AS (
    SELECT item_id FROM counted
    UNION
    SELECT item_id FROM public.gl_netsuite_stock_counts
  )
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', r.company, 'item_id', r.item_id, 'location_id', r.location_id,
        'opening_quantity', r.opening_quantity::text, 'opening_value', r.opening_value::text,
        'quantity', r.quantity::text, 'value', r.value::text,
        'documents', r.documents, 'last_date', to_char(r.last_date, 'YYYY-MM-DD')
      ) ORDER BY r.item_id::bigint, r.location_id NULLS FIRST, r.company)
      FROM counted r
    ), '[]'::jsonb),
    'netsuite', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'item_id', n.item_id, 'location_id', n.location_id, 'quantity', n.quantity::text, 'value', n.value::text
      ) ORDER BY n.item_id::bigint, n.location_id NULLS FIRST)
      FROM public.gl_netsuite_stock_counts n
    ), '[]'::jsonb),
    'netsuite_read_at', (SELECT max(read_at) FROM public.gl_netsuite_stock_counts),
    'items', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', i.netsuite_id, 'name', i.name, 'display_name', i.details->>'display_name', 'active', i.active
      ) ORDER BY i.netsuite_id::bigint)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (SELECT item_id FROM named)
    ), '[]'::jsonb),
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'netsuite_id', l.netsuite_id, 'name', l.name, 'subsidiary_id', l.details->>'subsidiary_id'
      ) ORDER BY l.name)
      FROM public.gl_netsuite_lists l
      WHERE l.kind = 'location'
    ), '[]'::jsonb),
    'ledger', coalesce((
      SELECT jsonb_agg(jsonb_build_object('company', c.code, 'balance', (
        coalesce((
          SELECT sum(o.debit - o.credit) FROM public.gl_netsuite_opening o
          WHERE o.company_id = c.id AND o.netsuite_account_id IN (SELECT id FROM asset_accounts)
        ), 0)
        + coalesce((
          SELECT sum(l.debit - l.credit) FROM public.gl_netsuite_lines l
          WHERE l.company_id = c.id AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)
        ), 0)
      )::text) ORDER BY c.code)
      FROM public.gl_companies c
    ), '[]'::jsonb),
    'accounts', coalesce((SELECT jsonb_agg(id ORDER BY id::bigint) FROM asset_accounts), '[]'::jsonb)
  )
$$;

-- One item's moves since its starting count: every copied NetSuite document
-- that moved it or posted to an inventory account on its lines, per company
-- and location, with how many it moved (the lines that move stock) and the
-- value it posted, oldest first, each with the count and value it left at
-- its location since 2025 (to add to the starting count) and the month
-- NetSuite posted it to, from the GL copy. At most p_limit (1 to 5000) of
-- them, the newest, and how many there are, with what all of them come to
-- at each location (totals). Also the item's starting count and NetSuite's
-- own count at each location, its name, and the locations'.
CREATE OR REPLACE FUNCTION public.gl_stock_item_moves(p_item TEXT, p_limit INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_out JSONB;
BEGIN
  IF coalesce(p_item, '') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: item must be a NetSuite id';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'gl: limit must be from 1 to 5000';
  END IF;

  WITH asset_accounts AS (
    SELECT DISTINCT i.details->>'asset_account' AS id
    FROM public.gl_netsuite_lists i
    WHERE i.kind = 'item' AND coalesce(i.details->>'asset_account', '') ~ '^[0-9]+$'
  ),
  live AS (
    SELECT s.document_id, s.line_id, s.company_id, s.location_id, s.quantity, s.moves_stock
    FROM public.gl_netsuite_stock_lines s
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = s.document_id
    WHERE s.item_id = p_item AND d.gone_at IS NULL
  ),
  moved AS (
    SELECT document_id, company_id, location_id,
           sum(quantity) FILTER (WHERE moves_stock) AS quantity, bool_or(moves_stock) AS moves
    FROM live
    GROUP BY document_id, company_id, location_id
  ),
  valued AS (
    SELECT s.document_id, s.company_id, s.location_id, sum(l.debit - l.credit) AS value
    FROM public.gl_netsuite_lines l
    JOIN live s ON s.document_id = l.transaction_id AND s.line_id = l.line_id
    WHERE l.netsuite_account_id IN (SELECT id FROM asset_accounts)
    GROUP BY s.document_id, s.company_id, s.location_id
  ),
  moves AS (
    SELECT m.document_id, m.company_id, m.location_id,
           coalesce(m.quantity, 0) AS quantity, coalesce(v.value, 0) AS value,
           d.tran_type, d.tranid, d.trandate
    FROM moved m
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = m.document_id
    LEFT JOIN valued v
      ON v.document_id = m.document_id AND v.company_id = m.company_id AND v.location_id IS NOT DISTINCT FROM m.location_id
    WHERE m.moves OR coalesce(v.value, 0) <> 0
  ),
  running AS (
    SELECT mv.*,
           sum(mv.quantity) OVER w AS quantity_since,
           sum(mv.value) OVER w AS value_since,
           row_number() OVER (ORDER BY mv.trandate DESC, mv.document_id::bigint DESC, mv.location_id DESC NULLS LAST) AS newest
    FROM moves mv
    WINDOW w AS (
      PARTITION BY mv.company_id, mv.location_id
      ORDER BY mv.trandate, mv.document_id::bigint
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    )
  )
  SELECT jsonb_build_object(
    'item', (
      SELECT jsonb_build_object('netsuite_id', i.netsuite_id, 'name', i.name, 'display_name', i.details->>'display_name', 'active', i.active)
      FROM public.gl_netsuite_lists i WHERE i.kind = 'item' AND i.netsuite_id = p_item
    ),
    'opening', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code, 'location_id', o.location_id, 'quantity', o.quantity::text, 'value', o.value::text
      ) ORDER BY o.location_id NULLS FIRST, c.code)
      FROM public.gl_netsuite_stock_opening o JOIN public.gl_companies c ON c.id = o.company_id
      WHERE o.item_id = p_item
    ), '[]'::jsonb),
    'netsuite', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'location_id', n.location_id, 'quantity', n.quantity::text, 'value', n.value::text
      ) ORDER BY n.location_id NULLS FIRST)
      FROM public.gl_netsuite_stock_counts n WHERE n.item_id = p_item
    ), '[]'::jsonb),
    'netsuite_read_at', (SELECT max(read_at) FROM public.gl_netsuite_stock_counts),
    'moves', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'document_id', r.document_id, 'type', r.tran_type, 'number', r.tranid, 'date', to_char(r.trandate, 'YYYY-MM-DD'),
        'company', c.code, 'location_id', r.location_id, 'quantity', r.quantity::text, 'value', r.value::text,
        'quantity_since', r.quantity_since::text, 'value_since', r.value_since::text,
        'posting_month', to_char(t.posting_month, 'YYYY-MM-DD')
      ) ORDER BY r.trandate, r.document_id::bigint, r.location_id NULLS FIRST)
      FROM running r
      JOIN public.gl_companies c ON c.id = r.company_id
      LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = r.document_id
      WHERE r.newest <= p_limit
    ), '[]'::jsonb),
    'count', (SELECT count(*) FROM moves),
    'totals', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code, 'location_id', x.location_id, 'quantity', x.quantity::text, 'value', x.value::text
      ) ORDER BY x.location_id NULLS FIRST, c.code)
      FROM (
        SELECT company_id, location_id, sum(quantity) AS quantity, sum(value) AS value
        FROM moves GROUP BY company_id, location_id
      ) x
      JOIN public.gl_companies c ON c.id = x.company_id
    ), '[]'::jsonb),
    'locations', coalesce((
      SELECT jsonb_agg(jsonb_build_object('netsuite_id', l.netsuite_id, 'name', l.name) ORDER BY l.name)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    ), '[]'::jsonb)
  ) INTO v_out;
  RETURN v_out;
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'gl_netsuite_stock_documents', 'gl_netsuite_stock_lines', 'gl_netsuite_stock_opening', 'gl_netsuite_stock_counts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_stock_apply(jsonb)',
    'public.gl_netsuite_stock_finish(jsonb)',
    'public.gl_netsuite_stock_store_opening(jsonb)',
    'public.gl_netsuite_stock_store_counts(jsonb)',
    'public.gl_stock_inventory_accounts()',
    'public.gl_stock_items()',
    'public.gl_stock_item_moves(text, integer)'
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

COMMENT ON TABLE gl_netsuite_stock_documents IS 'Migration 401: NetSuite documents dated from 2025 with a line that moves stock (transactionline.isinventoryaffecting), copied every two hours by src/lib/books/netsuite-stock.ts so FleetSuite counts each item itself. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_stock_documents.content_hash IS 'md5 of the document and its lines as last copied; an unchanged document is not rewritten.';
COMMENT ON COLUMN gl_netsuite_stock_documents.gone_at IS 'When a whole read of NetSuite''s stock documents no longer had it. NULL = still in NetSuite.';
COMMENT ON TABLE gl_netsuite_stock_lines IS 'Migration 401: every line of a copied stock document that names an item and belongs to BMG or 1084. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_stock_lines.line_id IS 'NetSuite''s transaction line id; the copy of NetSuite''s GL (gl_netsuite_lines) has the same id for what NetSuite posted on the line.';
COMMENT ON COLUMN gl_netsuite_stock_lines.quantity IS 'The line''s quantity as NetSuite keeps it: positive into stock, negative out of it.';
COMMENT ON COLUMN gl_netsuite_stock_lines.moves_stock IS 'NetSuite counts the line in the item''s stock (isinventoryaffecting). A line that names the item without moving it (a cost of goods line) is kept for its cost.';
COMMENT ON TABLE gl_netsuite_stock_opening IS 'Migration 401: where each item''s count starts, its count and value at each location on December 31, 2024, from NetSuite''s own lines before 2025, refreshed each run. Service-role write and read.';
COMMENT ON TABLE gl_netsuite_stock_counts IS 'Migration 401: NetSuite''s own count (and value, when it gives one) of each item at each location as last read, or of each item company-wide (location_id NULL) when it won''t say where. Service-role write and read.';
COMMENT ON FUNCTION public.gl_stock_items() IS 'Migration 401: every item FleetSuite counts at each location, for every company (starting count, count and value now), next to NetSuite''s own counts, with names, the inventory accounts and what the GL copy holds on them. Service role only.';
COMMENT ON FUNCTION public.gl_stock_item_moves(text, integer) IS 'Migration 401: one item''s moves since its starting count, per document, company and location, with running counts and values, its starting counts and NetSuite''s own counts. Service role only.';
