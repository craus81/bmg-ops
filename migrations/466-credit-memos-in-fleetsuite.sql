-- Migration 466: FleetSuite's own books, part 34 — credit memos made in
-- FleetSuite, switched off until January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Credit memos come first: from an invoice in
-- Invoicing → Invoiced, pick what to credit and FleetSuite makes the credit
-- memo in NetSuite (its "Credit" on the invoice), and Books keeps its own
-- copy (src/lib/credit-memo.ts, /api/invoices/credit-memo, page
-- /invoices/credit-memo, docs/books.md "Credit memos made in FleetSuite").
--
--   * books_switches, one row per piece that waits for its switch, off until
--     a super admin turns it on (Books → Switches). While off, super admins
--     can open the screen and see what it would send, and nothing goes to
--     NetSuite;
--   * quote_settings.netsuite_credit_item_id / _number, the NetSuite item a
--     credit with no part coming back goes on (Settings → NetSuite Credit
--     Item): a stock part credited on its own item goes back on the shelf;
--   * invoice_credit_memos, one row per press of Make credit memo. Its id
--     comes from the page, so a second press of the same form never makes a
--     second credit memo; claimed_at is the claim a try takes, and a refused
--     try keeps NetSuite's reason and lets go of the claim (as
--     typed_invoices, migration 445);
--   * gl_own_credit_memos and gl_own_credit_memo_lines, Books' own copy of
--     each credit memo FleetSuite makes, written only by
--     gl_own_credit_memo_save, which keeps each one whole: its subtotal and
--     tax add up from its lines, its total from those, and saving the same
--     NetSuite credit memo again changes nothing. Checking the copies against
--     NetSuite's comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── Switches ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_switches (
  -- Which piece: src/lib/books/switches.ts names each one.
  piece TEXT PRIMARY KEY CHECK (piece IN ('credit_memos')),
  is_on BOOLEAN NOT NULL DEFAULT false,
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ
);

INSERT INTO books_switches (piece) VALUES ('credit_memos') ON CONFLICT (piece) DO NOTHING;

-- ── The credit item ────────────────────────────────────────────────────────

ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_credit_item_id TEXT;
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS netsuite_credit_item_number TEXT;

COMMENT ON COLUMN quote_settings.netsuite_credit_item_id IS
  'Migration 466: NetSuite INTERNAL id of the non-stock item a credit memo credits money on when no part comes back. Null = not set, so those credits can''t be made.';
COMMENT ON COLUMN quote_settings.netsuite_credit_item_number IS
  'Migration 466: that item''s NetSuite name (itemid), stored for display only.';

INSERT INTO quote_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Each press of Make credit memo ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS invoice_credit_memos (
  id UUID PRIMARY KEY,
  -- The NetSuite invoice it credits.
  invoice_netsuite_id TEXT NOT NULL CHECK (invoice_netsuite_id ~ '^[0-9]+$'),
  invoice_number TEXT,
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_name TEXT,
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  -- The lines as sent: [{ invoiceLine, itemId, itemNumber, description, quantity, price, cents, taxable,
  --                       backToStock, onCreditItem }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT,
  claimed_at TIMESTAMPTZ,
  netsuite_credit_memo_id TEXT CHECK (netsuite_credit_memo_id ~ '^[0-9]+$'),
  netsuite_credit_memo_number TEXT,
  error TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS invoice_credit_memos_invoice_idx ON invoice_credit_memos (invoice_netsuite_id, created_at DESC);

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_credit_memos (
  -- NetSuite's internal id for the credit memo FleetSuite made; its copy there is ledger_invoices 'CustCred/<id>'.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  netsuite_number TEXT,
  -- The invoice it credits; NetSuite applies it there while the invoice is still owed.
  invoice_netsuite_id TEXT NOT NULL CHECK (invoice_netsuite_id ~ '^[0-9]+$'),
  invoice_number TEXT,
  -- The press of Make credit memo that made it (invoice_credit_memos).
  made_from_id UUID,
  customer_netsuite_id TEXT CHECK (customer_netsuite_id ~ '^[0-9]+$'),
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  -- The day FleetSuite made it, in Central time.
  credit_date DATE NOT NULL,
  -- The invoice's location, which NetSuite's credit memo takes from it.
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  -- How its sales tax was worked out (credit_tax@1: each line taxed as the invoice taxed it, at the invoice's rate),
  -- the rate (a fraction) and where the rate came from.
  tax_rule TEXT NOT NULL CHECK (btrim(tax_rule) <> ''),
  tax_rate NUMERIC(9,6) NOT NULL CHECK (tax_rate >= 0 AND tax_rate < 1),
  tax_rate_from TEXT NOT NULL CHECK (tax_rate_from IN ('invoice', 'tax_code', 'worked_out', 'untaxed')),
  subtotal NUMERIC(14,2) NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  total NUMERIC(14,2) NOT NULL,
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (total = subtotal + tax),
  CHECK (total > 0)
);
CREATE INDEX IF NOT EXISTS idx_gl_own_credit_memos_date ON gl_own_credit_memos(credit_date DESC, netsuite_id);
CREATE INDEX IF NOT EXISTS idx_gl_own_credit_memos_invoice ON gl_own_credit_memos(invoice_netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_credit_memo_lines (
  credit_memo_id TEXT NOT NULL REFERENCES gl_own_credit_memos(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  -- NetSuite's line key on the invoice it credits; null for an amount added on the credit item.
  invoice_line INTEGER CHECK (invoice_line >= 0),
  item_netsuite_id TEXT CHECK (item_netsuite_id ~ '^-?[0-9]+$'),
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(16,4),
  rate NUMERIC(16,4),
  -- What the line credits; a discount the invoice gave, credited back, negative.
  amount NUMERIC(14,2) NOT NULL CHECK (amount <> 0),
  taxable BOOLEAN NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  -- The part comes back on the shelf at O'Fallon.
  back_to_stock BOOLEAN NOT NULL DEFAULT false,
  -- The line went on the credit item, not the invoice line's own item.
  on_credit_item BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (credit_memo_id, line_no),
  CHECK (taxable OR tax = 0),
  CHECK (NOT (back_to_stock AND on_credit_item))
);
CREATE INDEX IF NOT EXISTS idx_gl_own_credit_memo_lines_invoice_line ON gl_own_credit_memo_lines(credit_memo_id, invoice_line);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Saves Books' own copy of a credit memo FleetSuite just made. p:
--   { netsuite_id, netsuite_number?, company? ('BMG'), invoice_netsuite_id, invoice_number?, made_from_id?,
--     customer_netsuite_id?, customer_id?, credit_date, location_netsuite_id?, reason, tax_rule, tax_rate,
--     tax_rate_from, subtotal, tax, total, made_by?,
--     lines: [{ line_no, invoice_line?, item_netsuite_id?, item_number?, description?, quantity?, rate?, amount,
--               taxable, tax, back_to_stock?, on_credit_item? }] }
-- Its lines must add up to its subtotal and tax. A copy of that credit memo already saved stays as it is. Returns
-- { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_credit_memo_save(p JSONB)
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
    RAISE EXCEPTION 'gl: an own credit memo needs NetSuite''s id for the credit memo';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(p->>'company', 'BMG');
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', 'BMG');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'gl: own credit memo % needs its lines', v_id;
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0), coalesce(sum((x.v->>'tax')::numeric), 0)
  INTO v_subtotal, v_tax
  FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_subtotal IS DISTINCT FROM (p->>'subtotal')::numeric OR v_tax IS DISTINCT FROM (p->>'tax')::numeric THEN
    RAISE EXCEPTION 'gl: own credit memo %''s lines don''t add up to its subtotal and tax', v_id;
  END IF;

  INSERT INTO public.gl_own_credit_memos (
    netsuite_id, company_id, netsuite_number, invoice_netsuite_id, invoice_number, made_from_id,
    customer_netsuite_id, customer_id, credit_date, location_netsuite_id, reason, tax_rule, tax_rate, tax_rate_from,
    subtotal, tax, total, made_by
  ) VALUES (
    v_id, v_company, nullif(btrim(p->>'netsuite_number'), ''), p->>'invoice_netsuite_id',
    nullif(btrim(p->>'invoice_number'), ''), nullif(p->>'made_from_id', '')::uuid,
    nullif(p->>'customer_netsuite_id', ''), nullif(p->>'customer_id', '')::uuid, (p->>'credit_date')::date,
    nullif(p->>'location_netsuite_id', ''), p->>'reason', p->>'tax_rule', (p->>'tax_rate')::numeric,
    p->>'tax_rate_from', (p->>'subtotal')::numeric, (p->>'tax')::numeric, (p->>'total')::numeric,
    nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_credit_memo_lines (
    credit_memo_id, line_no, invoice_line, item_netsuite_id, item_number, description, quantity, rate, amount,
    taxable, tax, back_to_stock, on_credit_item
  )
  SELECT v_id, x.line_no, x.invoice_line, nullif(x.item_netsuite_id, ''), nullif(x.item_number, ''),
         nullif(x.description, ''), x.quantity, x.rate, x.amount, x.taxable, x.tax, coalesce(x.back_to_stock, false),
         coalesce(x.on_credit_item, false)
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, invoice_line INTEGER, item_netsuite_id TEXT, item_number TEXT, description TEXT,
    quantity NUMERIC, rate NUMERIC, amount NUMERIC, taxable BOOLEAN, tax NUMERIC, back_to_stock BOOLEAN,
    on_credit_item BOOLEAN
  );

  RETURN jsonb_build_object('saved', true, 'lines', jsonb_array_length(v_lines));
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['books_switches', 'invoice_credit_memos', 'gl_own_credit_memos', 'gl_own_credit_memo_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.gl_own_credit_memo_save(jsonb)'] LOOP
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

COMMENT ON TABLE books_switches IS 'Migration 466: each piece that takes the team out of NetSuite, built switched off until a super admin turns it on (Books → Switches, src/lib/books/switches.ts). While off, super admins can see what it would send, and nothing goes to NetSuite. Service-role write and read.';
COMMENT ON TABLE invoice_credit_memos IS 'Migration 466: one row per press of Make credit memo (src/lib/credit-memo.ts, /api/invoices/credit-memo): the claim that keeps one press to one NetSuite credit memo, the lines sent, and what NetSuite made or why it refused. Service-role write and read.';
COMMENT ON TABLE gl_own_credit_memos IS 'Migration 466: Books'' own copy of each credit memo FleetSuite makes in NetSuite against an invoice, worked out by its own rules (src/lib/books/own-credit-memos.ts), saved only by gl_own_credit_memo_save, by NetSuite''s id for the credit memo. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON TABLE gl_own_credit_memo_lines IS 'Migration 466: the lines of Books'' own credit memos (gl_own_credit_memos), each with the invoice line it credits, its sales tax, and whether the part comes back on the shelf or the money went on the credit item. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_credit_memo_save(jsonb) IS 'Migration 466: saves Books'' own copy of a credit memo FleetSuite just made, refusing one whose lines don''t add up; one already saved stays as it is. Service role only.';
