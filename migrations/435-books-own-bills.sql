-- Migration 435: FleetSuite's own books, part 27 — shared bills, the first
-- piece: Books' own copy of each bill and PO receipt FleetSuite puts into
-- NetSuite, and one bill per approved vendor invoice or installer payout.
--
-- Owner decision 2026-10-24 (thread "Replacing NetSuite with FleetSuite",
-- "Shared bills", then "Fix it first" and "Build it"): each bill is entered
-- once, from FleetSuite, and Books keeps its own copy to check against
-- NetSuite's. FleetSuite already puts bills into NetSuite three ways, and PO
-- receipts one:
--   * Create Bill in NetSuite on an approved vendor invoice (AP,
--     /api/vendor-invoices/workflow) and on an approved installer payout
--     (/api/admin/payouts): one expense line, to Subcontractors;
--   * Create bill on a Parts Mail invoice (/api/parts-mail/create-bill): the
--     bill is made from the invoice's purchase order, so it carries the PO's
--     items at the PO's prices;
--   * Receive on the Receiving page (/api/po-receipts): an item receipt made
--     from the PO, or, when NetSuite won't take it, a line on Receiving's
--     list to enter in NetSuite by hand.
-- From now on each keeps Books' own copy of what it sent, worked out from
-- what FleetSuite knows (src/lib/books/own-bills.ts, own-receipts.ts), and
-- each copy is put next to NetSuite's (src/lib/books/own-bill-check.ts,
-- own-receipt-check.ts; docs/books.md "FleetSuite's own bills and receipts"):
--   * vendor_invoices.bill_claimed_at and payouts.bill_claimed_at, the claim a
--     try at Create Bill in NetSuite takes before it makes the bill
--     (src/lib/bill-once.ts), the shape migration 251 gave Parts Mail's bills;
--   * gl_own_bills and gl_own_bill_lines, the bill copies, written only by
--     gl_own_bill_save and keyed by NetSuite's id for the bill; saving the
--     same bill again changes nothing;
--   * gl_own_bill_pairs(from, to, netsuite_id), the copies made on those
--     days, or the one, each next to NetSuite's bill as the copy of its bills
--     has it (migration 384), with the companies the copy of its general
--     ledger books it to (migration 361);
--   * gl_own_receipts and gl_own_receipt_lines, the receipt copies, written
--     only by gl_own_receipt_save and keyed by FleetSuite's first row of the
--     Receive in po_receipts, with NetSuite's id for the item receipt when
--     NetSuite took it;
--   * gl_own_receipt_pairs(from, to, receipt_key), likewise, each next to
--     NetSuite's item receipt as the copy of its stock moves has it
--     (migration 401), each line valued from the copy of its general ledger,
--     with where Receiving's own rows for it stand;
--   * gl_own_bill_months() and gl_own_receipt_months(), how many copies were
--     made each month.
--
-- Writer and reader of the gl_ tables and functions: the service role only.
-- RLS is on with no policies, and anon/authenticated have no table or
-- function privileges.

-- ── One bill per approved vendor invoice or payout ────────────────────────
-- Nullable, no backfill: the routes bill unclaimed while PostgREST's schema
-- cache doesn't have the column yet (#741), so this deploying in the same
-- build as the code is safe in either order.

ALTER TABLE vendor_invoices
  ADD COLUMN IF NOT EXISTS bill_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN vendor_invoices.bill_claimed_at IS
  'Migration 435: atomic claim for Create Bill in NetSuite (/api/vendor-invoices/workflow, src/lib/bill-once.ts). Set while a try at the bill is in flight, and kept when NetSuite made the bill but the billed stamp failed; a claim over 15 minutes old is taken over. Cleared by the billed stamp, or when NetSuite refuses the bill.';

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS bill_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN payouts.bill_claimed_at IS
  'Migration 435: atomic claim for Create Bill in NetSuite on an installer payout (/api/admin/payouts, src/lib/bill-once.ts). Same shape as vendor_invoices.bill_claimed_at.';

-- ── Tables ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_bills (
  -- NetSuite's internal id for the bill FleetSuite made.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The number NetSuite gave it.
  netsuite_number TEXT,
  -- What FleetSuite billed: an approved vendor invoice (AP), an installer payout, or a Parts Mail invoice.
  made_from TEXT NOT NULL CHECK (made_from IN ('vendor_invoice', 'payout', 'parts_mail')),
  -- The FleetSuite record it billed: the vendor invoice, payout or parts invoice.
  made_from_id TEXT,
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  -- The Reference No. FleetSuite sent: the vendor's invoice number, or one it made up.
  reference_no TEXT,
  -- The day FleetSuite made it, in Central time: NetSuite dates a bill it isn't given a date for that day.
  bill_date DATE NOT NULL,
  -- The purchase order a Parts Mail bill was made from.
  po_netsuite_id TEXT CHECK (po_netsuite_id ~ '^[0-9]+$'),
  po_number TEXT,
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  -- What the vendor's invoice says it comes to, when FleetSuite read one (Parts Mail).
  invoice_total NUMERIC(16,2),
  -- What FleetSuite couldn't work out: 'lines' (its copy of the purchase order didn't have the order), 'prices'
  -- (it had no price for a line).
  unknowns TEXT[] NOT NULL DEFAULT '{}'
    CHECK (unknowns <@ ARRAY['lines', 'prices']::text[]),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_bills_date ON gl_own_bills(bill_date DESC, netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_bill_lines (
  bill_id TEXT NOT NULL REFERENCES gl_own_bills(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  -- An expense line names its account, an item line its item.
  account_netsuite_id TEXT CHECK (account_netsuite_id ~ '^[0-9]+$'),
  item_netsuite_id TEXT CHECK (item_netsuite_id ~ '^[0-9]+$'),
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(16,4),
  rate NUMERIC(16,4),
  -- Null when FleetSuite had no price for the line.
  amount NUMERIC(16,2),
  -- The purchase order line it bills.
  po_line_id TEXT,
  PRIMARY KEY (bill_id, line_no),
  CHECK (account_netsuite_id IS NULL OR item_netsuite_id IS NULL)
);

CREATE TABLE IF NOT EXISTS gl_own_receipts (
  -- FleetSuite's first po_receipts row of the Receive: one tap of Receive is one receipt.
  receipt_key UUID PRIMARY KEY,
  -- NetSuite's internal id for the item receipt; null when NetSuite didn't take it.
  netsuite_id TEXT UNIQUE CHECK (netsuite_id ~ '^[0-9]+$'),
  netsuite_number TEXT,
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  po_netsuite_id TEXT CHECK (po_netsuite_id ~ '^[0-9]+$'),
  po_number TEXT,
  vendor_netsuite_id TEXT CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  -- The date FleetSuite gave NetSuite for it.
  receive_date DATE NOT NULL,
  -- Why NetSuite didn't take it, as FleetSuite was told.
  netsuite_error TEXT,
  -- What FleetSuite couldn't work out: 'prices' (its copy of the purchase order had no price for a line).
  unknowns TEXT[] NOT NULL DEFAULT '{}'
    CHECK (unknowns <@ ARRAY['prices']::text[]),
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gl_own_receipts_date ON gl_own_receipts(receive_date DESC, made_at DESC);

CREATE TABLE IF NOT EXISTS gl_own_receipt_lines (
  receipt_key UUID NOT NULL REFERENCES gl_own_receipts(receipt_key) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  item_netsuite_id TEXT CHECK (item_netsuite_id ~ '^[0-9]+$'),
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(16,4) NOT NULL CHECK (quantity > 0),
  -- The purchase order line's price as FleetSuite's copy of the PO had it; null when it had none.
  rate NUMERIC(16,4),
  po_line_id TEXT,
  -- FleetSuite's own row for the line on Receiving (po_receipts).
  po_receipt_id UUID,
  PRIMARY KEY (receipt_key, line_no)
);

-- ── The writers ────────────────────────────────────────────────────────────

-- The company a copy is for: the one whose NetSuite subsidiary it was made in, else the one named, else BMG.
CREATE OR REPLACE FUNCTION public.gl_own_copy_company(p JSONB)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
BEGIN
  IF coalesce(p->>'subsidiary_id', '') <> '' THEN
    SELECT id INTO v_company FROM public.gl_companies WHERE netsuite_subsidiary_id = p->>'subsidiary_id';
  END IF;
  IF v_company IS NULL THEN
    SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(nullif(p->>'company', ''), 'BMG');
  END IF;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(nullif(p->>'company', ''), 'BMG');
  END IF;
  RETURN v_company;
END;
$$;

-- Saves Books' own copy of a bill FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, subsidiary_id?, company? ('BMG'), made_from, made_from_id?, vendor_netsuite_id?,
--     vendor_name?, reference_no?, bill_date, po_netsuite_id?, po_number?, location_netsuite_id?, invoice_total?,
--     unknowns?, made_by?,
--     lines: [{ line_no, account_netsuite_id?, item_netsuite_id?, item_number?, description?, quantity?, rate?, amount,
--               po_line_id? }] }
-- A copy of that bill already saved stays as it is. Returns { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_bill_save(p JSONB)
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
    RAISE EXCEPTION 'gl: an own bill needs NetSuite''s id for the bill';
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  v_company := public.gl_own_copy_company(p);

  INSERT INTO public.gl_own_bills (
    netsuite_id, company_id, netsuite_number, made_from, made_from_id, vendor_netsuite_id, vendor_name, reference_no,
    bill_date, po_netsuite_id, po_number, location_netsuite_id, invoice_total, unknowns, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), p->>'made_from', nullif(p->>'made_from_id', ''),
    nullif(p->>'vendor_netsuite_id', ''), nullif(btrim(p->>'vendor_name'), ''), nullif(btrim(p->>'reference_no'), ''),
    (p->>'bill_date')::date, nullif(p->>'po_netsuite_id', ''), nullif(btrim(p->>'po_number'), ''),
    nullif(p->>'location_netsuite_id', ''), nullif(p->>'invoice_total', '')::numeric,
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'unknowns', '[]'::jsonb))), '{}'),
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_bill_lines (
    bill_id, line_no, account_netsuite_id, item_netsuite_id, item_number, description, quantity, rate, amount, po_line_id
  )
  SELECT v_id, x.line_no, nullif(x.account_netsuite_id, ''), nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''),
         nullif(x.description, ''), x.quantity, x.rate, x.amount, nullif(x.po_line_id, '')
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, account_netsuite_id TEXT, item_netsuite_id TEXT, item_number TEXT, description TEXT,
    quantity NUMERIC, rate NUMERIC, amount NUMERIC, po_line_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- Saves Books' own copy of a Receive on the Receiving page. p:
--   { receipt_key, netsuite_id?, netsuite_number?, subsidiary_id?, company? ('BMG'), po_netsuite_id?, po_number?,
--     vendor_netsuite_id?, vendor_name?, receive_date, netsuite_error?, unknowns?, made_by?,
--     lines: [{ line_no, item_netsuite_id?, item_number?, description?, quantity, rate?, po_line_id?, po_receipt_id? }] }
-- A copy of that Receive, or of that NetSuite item receipt, already saved stays as it is. Returns { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_receipt_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_key UUID;
  v_id TEXT := nullif(p->>'netsuite_id', '');
  v_company UUID;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_inserted INTEGER;
BEGIN
  IF coalesce(p->>'receipt_key', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'gl: an own receipt needs FleetSuite''s receipt row';
  END IF;
  v_key := (p->>'receipt_key')::uuid;
  IF v_id IS NOT NULL AND v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: NetSuite id "%" isn''t a number', v_id;
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: lines must be a list';
  END IF;
  v_company := public.gl_own_copy_company(p);

  INSERT INTO public.gl_own_receipts (
    receipt_key, netsuite_id, netsuite_number, company_id, po_netsuite_id, po_number, vendor_netsuite_id, vendor_name,
    receive_date, netsuite_error, unknowns, made_by
  ) VALUES (
    v_key, v_id, nullif(btrim(p->>'netsuite_number'), ''), v_company, nullif(p->>'po_netsuite_id', ''),
    nullif(btrim(p->>'po_number'), ''), nullif(p->>'vendor_netsuite_id', ''), nullif(btrim(p->>'vendor_name'), ''),
    (p->>'receive_date')::date, nullif(left(p->>'netsuite_error', 500), ''),
    coalesce(ARRAY(SELECT jsonb_array_elements_text(coalesce(p->'unknowns', '[]'::jsonb))), '{}'),
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_receipt_lines (
    receipt_key, line_no, item_netsuite_id, item_number, description, quantity, rate, po_line_id, po_receipt_id
  )
  SELECT v_key, x.line_no, nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''), nullif(x.description, ''),
         x.quantity, x.rate, nullif(x.po_line_id, ''), nullif(x.po_receipt_id, '')::uuid
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, item_netsuite_id TEXT, item_number TEXT, description TEXT, quantity NUMERIC, rate NUMERIC,
    po_line_id TEXT, po_receipt_id TEXT
  );

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Readers ────────────────────────────────────────────────────────────────

-- Books' own bills made from p_from to p_to, or only the one whose NetSuite id is p_netsuite_id, newest first, each
-- next to NetSuite's bill:
--   bills:    [{ own: the copy with its lines,
--                  netsuite: NetSuite's bill as the copy of its bills has it (migration 384): number, type, date, vendor,
--                            total, status, voided, gone, lines and links as copied, and companies, the companies the
--                            copy of its general ledger books its lines to (empty before that copy has it); null
--                            before the bills copy has it }]
--   accounts: { <NetSuite account id>: { number, name } } for the accounts either side's lines name
--   items:    { <NetSuite item id>: { number, type, display_name } } for the items either side's lines name
-- Amounts and quantities are decimal strings.
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

-- Books' own receipts made from p_from to p_to, or only the one whose key is p_key, newest first, each next to
-- NetSuite's item receipt:
--   receipts:  [{ own: the copy with its lines,
--                 netsuite: NetSuite's item receipt as the copy of its stock moves has it (migration 401): number,
--                           date, gone, and each line that names an item: its company, location, quantity (stock in
--                           positive), whether it moves stock, and its value, what NetSuite posted to an inventory
--                           account on it in the copy of its general ledger (debit positive; null when that copy has
--                           nothing on the line); null when NetSuite didn't take it, or before the stock copy has it,
--                 in_ledger: whether the copy of NetSuite's general ledger has the item receipt,
--                 receiving: how many of Receiving's rows for it (po_receipts) stand at posted, manual_needed and
--                            manual_done }]
--   items:     { <NetSuite item id>: { number, type, display_name } } for the items either side's lines name
--   locations: { <NetSuite location id>: name }
-- Amounts and quantities are decimal strings.
CREATE OR REPLACE FUNCTION public.gl_own_receipt_pairs(p_from DATE, p_to DATE, p_key UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH own AS (
    SELECT o.*, c.code AS company
    FROM public.gl_own_receipts o
    JOIN public.gl_companies c ON c.id = o.company_id
    WHERE CASE WHEN p_key IS NOT NULL THEN o.receipt_key = p_key
               ELSE o.receive_date BETWEEN p_from AND p_to END
  ),
  asset_accounts AS (
    SELECT id FROM jsonb_array_elements_text(public.gl_stock_inventory_accounts()) AS a(id)
  ),
  twin AS (
    SELECT o.receipt_key, d.*
    FROM own o
    JOIN public.gl_netsuite_stock_documents d ON d.netsuite_id = o.netsuite_id
  ),
  twin_lines AS (
    SELECT t.receipt_key, s.line_id, gc.code AS company, s.item_id, s.location_id, s.quantity, s.moves_stock,
           (SELECT sum(l.debit - l.credit)
            FROM public.gl_netsuite_lines l
            WHERE l.transaction_id = s.document_id AND l.line_id = s.line_id
              AND l.netsuite_account_id IN (SELECT id FROM asset_accounts)) AS value
    FROM twin t
    JOIN public.gl_netsuite_stock_lines s ON s.document_id = t.netsuite_id
    JOIN public.gl_companies gc ON gc.id = s.company_id
  )
  SELECT jsonb_build_object(
    'receipts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'own', jsonb_build_object(
          'receipt_key', o.receipt_key,
          'netsuite_id', o.netsuite_id,
          'number', o.netsuite_number,
          'company', o.company,
          'po_id', o.po_netsuite_id,
          'po_number', o.po_number,
          'vendor_id', o.vendor_netsuite_id,
          'vendor_name', o.vendor_name,
          'date', to_char(o.receive_date, 'YYYY-MM-DD'),
          'netsuite_error', o.netsuite_error,
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
              'po_line_id', l.po_line_id,
              'po_receipt_id', l.po_receipt_id
            ) ORDER BY l.line_no), '[]'::jsonb)
            FROM public.gl_own_receipt_lines l
            WHERE l.receipt_key = o.receipt_key
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
                'company', tl.company,
                'item_id', tl.item_id,
                'location_id', tl.location_id,
                'quantity', tl.quantity::text,
                'moves_stock', tl.moves_stock,
                'value', tl.value::text
              ) ORDER BY tl.line_id::bigint), '[]'::jsonb)
              FROM twin_lines tl
              WHERE tl.receipt_key = o.receipt_key
            )
          )
          FROM twin t
          WHERE t.receipt_key = o.receipt_key
        ),
        'in_ledger', o.netsuite_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.gl_netsuite_transactions g WHERE g.netsuite_id = o.netsuite_id),
        'receiving', (
          SELECT jsonb_build_object(
            'posted', count(*) FILTER (WHERE r.ns_status = 'posted'),
            'manual_needed', count(*) FILTER (WHERE r.ns_status = 'manual_needed'),
            'manual_done', count(*) FILTER (WHERE r.ns_status = 'manual_done')
          )
          FROM public.po_receipts r
          WHERE r.id IN (SELECT l.po_receipt_id FROM public.gl_own_receipt_lines l WHERE l.receipt_key = o.receipt_key)
        )
      ) ORDER BY o.receive_date DESC, o.made_at DESC), '[]'::jsonb)
      FROM own o
    ),
    'items', (
      SELECT coalesce(jsonb_object_agg(i.netsuite_id, jsonb_build_object(
        'number', i.name, 'type', i.details->>'item_type', 'display_name', i.details->>'display_name'
      )), '{}'::jsonb)
      FROM public.gl_netsuite_lists i
      WHERE i.kind = 'item' AND i.netsuite_id IN (
        SELECT l.item_netsuite_id FROM public.gl_own_receipt_lines l JOIN own o ON o.receipt_key = l.receipt_key
        UNION
        SELECT tl.item_id FROM twin_lines tl
      )
    ),
    'locations', (
      SELECT coalesce(jsonb_object_agg(l.netsuite_id, l.name), '{}'::jsonb)
      FROM public.gl_netsuite_lists l WHERE l.kind = 'location'
    )
  )
$$;

-- How many own bills Books kept each month, newest first: [{ month: 'YYYY-MM-01', bills }].
CREATE OR REPLACE FUNCTION public.gl_own_bill_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'bills', m.bills)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', bill_date)::date AS month, count(*) AS bills
    FROM public.gl_own_bills
    GROUP BY 1
  ) m
$$;

-- How many own receipts Books kept each month, newest first: [{ month: 'YYYY-MM-01', receipts }].
CREATE OR REPLACE FUNCTION public.gl_own_receipt_months()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', to_char(m.month, 'YYYY-MM-DD'), 'receipts', m.receipts)
                            ORDER BY m.month DESC), '[]'::jsonb)
  FROM (
    SELECT date_trunc('month', receive_date)::date AS month, count(*) AS receipts
    FROM public.gl_own_receipts
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
  FOREACH t IN ARRAY ARRAY['gl_own_bills', 'gl_own_bill_lines', 'gl_own_receipts', 'gl_own_receipt_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_own_copy_company(jsonb)',
    'public.gl_own_bill_save(jsonb)',
    'public.gl_own_receipt_save(jsonb)',
    'public.gl_own_bill_pairs(date, date, text)',
    'public.gl_own_receipt_pairs(date, date, uuid)',
    'public.gl_own_bill_months()',
    'public.gl_own_receipt_months()'
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

COMMENT ON TABLE gl_own_bills IS 'Migration 435: Books'' own copy of each bill FleetSuite puts into NetSuite (an approved vendor invoice, an installer payout, a Parts Mail invoice), worked out from what FleetSuite knows (src/lib/books/own-bills.ts), saved only by gl_own_bill_save, by NetSuite''s id for the bill. Not posted to the books yet. Service-role write and read.';
COMMENT ON TABLE gl_own_bill_lines IS 'Migration 435: the lines of Books'' own bills (gl_own_bills): an expense line''s account, or an item line''s item, quantity and price, each with its amount. Service-role write and read.';
COMMENT ON TABLE gl_own_receipts IS 'Migration 435: Books'' own copy of each Receive on the Receiving page (src/lib/books/own-receipts.ts), keyed by its first po_receipts row, with NetSuite''s id for the item receipt when NetSuite took it. Saved only by gl_own_receipt_save. Not posted to the books yet. Service-role write and read.';
COMMENT ON TABLE gl_own_receipt_lines IS 'Migration 435: what each of Books'' own receipts (gl_own_receipts) brought in, item by item, at the purchase order''s price as FleetSuite''s copy of the PO had it. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_copy_company(jsonb) IS 'Migration 435: the company an own bill or receipt is for: the one whose NetSuite subsidiary it was made in, else the one named, else BMG. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_save(jsonb) IS 'Migration 435: saves Books'' own copy of a bill FleetSuite just made; one already saved stays as it is. Service role only.';
COMMENT ON FUNCTION public.gl_own_receipt_save(jsonb) IS 'Migration 435: saves Books'' own copy of a Receive on the Receiving page; one already saved stays as it is. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_pairs(date, date, text) IS 'Migration 435: Books'' own bills made on some days, or one, each next to NetSuite''s bill as the copy of its bills has it, with the companies the copy of its general ledger books it to, for the Own bills page and the daily check. Service role only.';
COMMENT ON FUNCTION public.gl_own_receipt_pairs(date, date, uuid) IS 'Migration 435: Books'' own receipts made on some days, or one, each next to NetSuite''s item receipt as the copies of its stock moves and general ledger have it, with where Receiving''s rows for it stand, for the Own receipts page and the daily check. Service role only.';
COMMENT ON FUNCTION public.gl_own_bill_months() IS 'Migration 435: how many own bills Books kept each month. Service role only.';
COMMENT ON FUNCTION public.gl_own_receipt_months() IS 'Migration 435: how many own receipts Books kept each month. Service role only.';
