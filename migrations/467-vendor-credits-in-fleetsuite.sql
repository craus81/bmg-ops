-- Migration 467: FleetSuite's own books, part 35 — vendor credits made in
-- FleetSuite, switched off until January 1, 2027.
--
-- Owner decisions 2026-10-31 (thread "Replacing NetSuite with FleetSuite"):
-- from January 1, 2027 the team works only in FleetSuite, apart from
-- receiving and making payments, deposits and banking; each piece that takes
-- them out of NetSuite is built switched off, and FleetSuite sends its
-- document on to NetSuite. Vendor credits come second: in Purchasing →
-- Vendor Credits, enter the vendor's credit (money back to an account, or a
-- part going back to the vendor), pick which of the vendor's open bills it
-- applies to, and FleetSuite makes the vendor credit in NetSuite, and Books
-- keeps its own copy (src/lib/vendor-credit.ts, /api/purchasing/vendor-credit,
-- page /admin/purchasing/vendor-credit, docs/books.md "Vendor credits made in
-- FleetSuite").
--
--   * books_switches takes a second piece, vendor_credits, off;
--   * typed_vendor_credits, one row per press of Make vendor credit. Its id
--     comes from the page, so a second press of the same form never makes a
--     second vendor credit; claimed_at is the claim a try takes, and a refused
--     try keeps NetSuite's reason and lets go of the claim (as
--     invoice_credit_memos, migration 466). Two presses can't make the same
--     vendor's credit number twice: one being made or made holds it;
--   * gl_own_vendor_credits and gl_own_vendor_credit_lines, Books' own copy of
--     each vendor credit FleetSuite makes, written only by
--     gl_own_vendor_credit_save, which keeps each one whole: its total adds up
--     from its lines, what it applies to bills from what it applied, and
--     saving the same NetSuite vendor credit again changes nothing. Checking
--     the copies against NetSuite's comes after.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 466 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names both.
DO $$
DECLARE
  c TEXT;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.books_switches'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%piece%'
  LOOP
    EXECUTE format('ALTER TABLE public.books_switches DROP CONSTRAINT %I', c);
  END LOOP;
END $$;

ALTER TABLE books_switches ADD CONSTRAINT books_switches_piece_check CHECK (piece IN ('credit_memos', 'vendor_credits'));

INSERT INTO books_switches (piece) VALUES ('vendor_credits') ON CONFLICT (piece) DO NOTHING;

-- ── Each press of Make vendor credit ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS typed_vendor_credits (
  id UUID PRIMARY KEY,
  -- gl_companies.code: whose books it's in.
  company TEXT NOT NULL CHECK (btrim(company) <> ''),
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  -- The vendor's own number for the credit, its Reference No. in NetSuite.
  credit_number TEXT NOT NULL CHECK (btrim(credit_number) <> '' AND length(credit_number) <= 40),
  credit_date DATE NOT NULL,
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  -- The lines as sent: [{ kind, accountId, itemId, itemNumber, description, quantity, rate, cents }].
  lines JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- The bills it applies to: [{ billId, billNumber, cents }].
  applied JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT,
  applied_cents BIGINT,
  claimed_at TIMESTAMPTZ,
  netsuite_vendor_credit_id TEXT CHECK (netsuite_vendor_credit_id ~ '^[0-9]+$'),
  error TEXT,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS typed_vendor_credits_vendor_idx ON typed_vendor_credits (vendor_netsuite_id, created_at DESC);
-- One vendor credit per vendor's credit number: a press being made or made holds it, one NetSuite refused doesn't.
CREATE UNIQUE INDEX IF NOT EXISTS typed_vendor_credits_once ON typed_vendor_credits (vendor_netsuite_id, upper(btrim(credit_number)))
  WHERE claimed_at IS NOT NULL OR netsuite_vendor_credit_id IS NOT NULL;

-- ── Books' own copy ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_own_vendor_credits (
  -- NetSuite's internal id for the vendor credit FleetSuite made; its copy there is gl_netsuite_bills (VendCred).
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]+$'),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The press of Make vendor credit that made it (typed_vendor_credits).
  made_from_id UUID,
  vendor_netsuite_id TEXT NOT NULL CHECK (vendor_netsuite_id ~ '^[0-9]+$'),
  vendor_name TEXT,
  credit_number TEXT NOT NULL CHECK (btrim(credit_number) <> ''),
  -- The date on the vendor's credit.
  credit_date DATE NOT NULL,
  location_netsuite_id TEXT CHECK (location_netsuite_id ~ '^[0-9]+$'),
  reason TEXT NOT NULL CHECK (btrim(reason) <> ''),
  -- How FleetSuite worked it out (vendor_credit@1: each line its own amount, a part's quantity times its rate).
  rule TEXT NOT NULL CHECK (btrim(rule) <> ''),
  total NUMERIC(14,2) NOT NULL CHECK (total > 0),
  -- What it applied to the vendor's open bills; the rest stays open on the vendor.
  applied NUMERIC(14,2) NOT NULL DEFAULT 0,
  -- [{ bill_netsuite_id, bill_number, amount }]
  applied_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  made_by UUID,
  made_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (applied >= 0 AND applied <= total)
);
CREATE INDEX IF NOT EXISTS idx_gl_own_vendor_credits_date ON gl_own_vendor_credits(credit_date DESC, netsuite_id);
CREATE INDEX IF NOT EXISTS idx_gl_own_vendor_credits_vendor ON gl_own_vendor_credits(vendor_netsuite_id);

CREATE TABLE IF NOT EXISTS gl_own_vendor_credit_lines (
  vendor_credit_id TEXT NOT NULL REFERENCES gl_own_vendor_credits(netsuite_id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  -- 'account': money back to an account; 'part': a part going back to the vendor, out of O'Fallon's stock.
  kind TEXT NOT NULL CHECK (kind IN ('account', 'part')),
  account_netsuite_id TEXT CHECK (account_netsuite_id ~ '^[0-9]+$'),
  item_netsuite_id TEXT CHECK (item_netsuite_id ~ '^[0-9]+$'),
  item_number TEXT,
  description TEXT,
  quantity NUMERIC(16,4),
  rate NUMERIC(16,4),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (vendor_credit_id, line_no),
  CHECK (
    (kind = 'account' AND account_netsuite_id IS NOT NULL AND item_netsuite_id IS NULL)
    OR (kind = 'part' AND item_netsuite_id IS NOT NULL AND account_netsuite_id IS NULL AND quantity > 0 AND rate > 0)
  )
);

-- ── The writer ─────────────────────────────────────────────────────────────

-- Saves Books' own copy of a vendor credit FleetSuite just made. p:
--   { netsuite_id, company? ('BMG'), made_from_id?, vendor_netsuite_id, vendor_name?, credit_number, credit_date,
--     location_netsuite_id?, reason, rule, total, applied, applied_to: [{ bill_netsuite_id, bill_number?, amount }],
--     made_by?,
--     lines: [{ line_no, kind, account_netsuite_id?, item_netsuite_id?, item_number?, description?, quantity?, rate?,
--               amount }] }
-- Its lines must add up to its total, and what it applied to bills to what it says it applied. A copy of that vendor
-- credit already saved stays as it is. Returns { saved, lines }.
CREATE OR REPLACE FUNCTION public.gl_own_vendor_credit_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id TEXT := p->>'netsuite_id';
  v_company UUID;
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_applied_to JSONB := coalesce(p->'applied_to', '[]'::jsonb);
  v_total NUMERIC;
  v_applied NUMERIC;
  v_inserted INTEGER;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'gl: an own vendor credit needs NetSuite''s id for the vendor credit';
  END IF;
  SELECT id INTO v_company FROM public.gl_companies WHERE code = coalesce(p->>'company', 'BMG');
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: company % doesn''t exist', coalesce(p->>'company', 'BMG');
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(v_lines) = 0 THEN
    RAISE EXCEPTION 'gl: own vendor credit % needs its lines', v_id;
  END IF;
  IF jsonb_typeof(v_applied_to) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: own vendor credit %''s bills must be a list', v_id;
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0) INTO v_total FROM jsonb_array_elements(v_lines) AS x(v);
  IF v_total IS DISTINCT FROM (p->>'total')::numeric THEN
    RAISE EXCEPTION 'gl: own vendor credit %''s lines don''t add up to its total', v_id;
  END IF;
  SELECT coalesce(sum((x.v->>'amount')::numeric), 0) INTO v_applied FROM jsonb_array_elements(v_applied_to) AS x(v);
  IF v_applied IS DISTINCT FROM (p->>'applied')::numeric
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_applied_to) AS x(v)
                WHERE coalesce(x.v->>'bill_netsuite_id', '') !~ '^[0-9]+$' OR (x.v->>'amount')::numeric <= 0) THEN
    RAISE EXCEPTION 'gl: own vendor credit %''s bills don''t add up to what it applied', v_id;
  END IF;

  INSERT INTO public.gl_own_vendor_credits (
    netsuite_id, company_id, made_from_id, vendor_netsuite_id, vendor_name, credit_number, credit_date,
    location_netsuite_id, reason, rule, total, applied, applied_to, made_by
  ) VALUES (
    v_id, v_company, nullif(p->>'made_from_id', '')::uuid, p->>'vendor_netsuite_id', nullif(btrim(p->>'vendor_name'), ''),
    btrim(p->>'credit_number'), (p->>'credit_date')::date, nullif(p->>'location_netsuite_id', ''), p->>'reason',
    p->>'rule', (p->>'total')::numeric, (p->>'applied')::numeric, v_applied_to, nullif(p->>'made_by', '')::uuid
  )
  ON CONFLICT (netsuite_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    RETURN jsonb_build_object('saved', false, 'lines', 0);
  END IF;

  INSERT INTO public.gl_own_vendor_credit_lines (
    vendor_credit_id, line_no, kind, account_netsuite_id, item_netsuite_id, item_number, description, quantity, rate,
    amount
  )
  SELECT v_id, x.line_no, x.kind, nullif(x.account_netsuite_id, ''), nullif(x.item_netsuite_id, ''),
         nullif(x.item_number, ''), nullif(x.description, ''), x.quantity, x.rate, x.amount
  FROM jsonb_to_recordset(v_lines) AS x(
    line_no INTEGER, kind TEXT, account_netsuite_id TEXT, item_netsuite_id TEXT, item_number TEXT, description TEXT,
    quantity NUMERIC, rate NUMERIC, amount NUMERIC
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
  FOREACH t IN ARRAY ARRAY['typed_vendor_credits', 'gl_own_vendor_credits', 'gl_own_vendor_credit_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %I FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.gl_own_vendor_credit_save(jsonb)'] LOOP
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

COMMENT ON TABLE typed_vendor_credits IS 'Migration 467: one row per press of Make vendor credit (src/lib/vendor-credit.ts, /api/purchasing/vendor-credit): the claim that keeps one press to one NetSuite vendor credit and one vendor credit per vendor''s credit number, the lines and bills sent, and what NetSuite made or why it refused. Service-role write and read.';
COMMENT ON TABLE gl_own_vendor_credits IS 'Migration 467: Books'' own copy of each vendor credit FleetSuite makes in NetSuite, worked out by its own rules (src/lib/books/own-vendor-credits.ts), saved only by gl_own_vendor_credit_save, by NetSuite''s id for the vendor credit. Not checked against NetSuite''s or posted yet. Service-role write and read.';
COMMENT ON TABLE gl_own_vendor_credit_lines IS 'Migration 467: the lines of Books'' own vendor credits (gl_own_vendor_credits): money back to an account, or a part going back to the vendor out of O''Fallon''s stock. Service-role write and read.';
COMMENT ON FUNCTION public.gl_own_vendor_credit_save(jsonb) IS 'Migration 467: saves Books'' own copy of a vendor credit FleetSuite just made, refusing one whose lines or bills don''t add up; one already saved stays as it is. Service role only.';
