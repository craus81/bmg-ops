-- Migration 497: FleetSuite's own books, part 67 — FleetSuite's own numbers
-- for the sales orders, POs, invoices and credit memos it makes, switched off.
--
-- The NetSuite Exit Checklist's "FleetSuite's own numbers" (thread "Replacing
-- NetSuite with FleetSuite"; src/lib/books/own-numbers.ts,
-- /api/admin/books/own-numbers, page /admin/books/own-numbers, docs/books.md
-- "Own numbers"; the plan has every sales order and PO start in FleetSuite
-- with its own number, and FleetSuite's numbers copied to NetSuite, from the
-- second quarter of 2027). Today NetSuite numbers everything FleetSuite makes
-- there. Once FleetSuite's own numbers is switched on, FleetSuite takes the
-- next number of the kind before it sends, and NetSuite gets it as the
-- document's number:
--
--   * books_switches gets 'own_numbers', off;
--   * own_number_series, one row per kind (sales order, PO, invoice, credit
--     memo): the letters it starts with and the next number. They start at
--     SO10001, PO10001, INV10001 and CM10001: the same letters as NetSuite's
--     own, and well past any number NetSuite has given, so a document still
--     numbered by NetSuite can't take one of FleetSuite's for years. A super
--     admin can change them on Books → Own numbers;
--   * own_numbers, every number FleetSuite has taken and what became of it:
--     NetSuite made the document (with its internal ID and the number it
--     kept, which is FleetSuite's unless Allow Override is off for that kind
--     in NetSuite), NetSuite refused it, or FleetSuite isn't sure NetSuite
--     made it. A number is never given twice, even one NetSuite refused, so
--     each gap in the numbers has its reason here;
--   * own_number_reserve(p_type, p_by) takes the next number, passing over
--     any FleetSuite gave already or that's on one of NetSuite's documents in
--     FleetSuite's copies (netsuite_sales_orders, netsuite_vendor_pos with a
--     customer ending after a dash too, ledger_invoices, gl_own_invoices and
--     gl_own_credit_memos). Taking the series row's lock first means two at
--     once never get the same number. own_number_settle(...) says what became
--     of it, once;
--   * own_numbers_made_outside(p_since, p_limit): the sales orders and POs in
--     FleetSuite's copies dated from p_since that FleetSuite didn't make: no
--     own number made it, the NetSuite feed (migration 477) has no send that
--     made it, and it isn't a drop ship PO NetSuite made for one of
--     FleetSuite's sales orders. Never before the first send the feed kept. And
--     own_number_outside_told, the ones the daily check has told about;
--   * own_numbers_to_tell(p_since, p_limit) and own_numbers_mark_told(...),
--     for the daily check: the numbers NetSuite didn't keep, and the sales
--     orders and POs made in NetSuite instead, that it hasn't told about.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

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

ALTER TABLE books_switches ADD CONSTRAINT books_switches_piece_check
  CHECK (piece IN ('credit_memos', 'vendor_credits', 'card_charges', 'journal_entries', 'inventory_transfers', 'invoice_fixes',
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records',
                   'customer_payments', 'customer_deposits', 'bank_deposits', 'vendor_payments', 'adjustment_approvals',
                   'own_numbers'));

INSERT INTO books_switches (piece) VALUES ('own_numbers') ON CONFLICT (piece) DO NOTHING;

-- ── Each kind's numbers ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS own_number_series (
  doc_type TEXT PRIMARY KEY CHECK (doc_type IN ('sales_order', 'purchase_order', 'invoice', 'credit_memo')),
  -- The letters every number starts with, as NetSuite's own do: SO, PO, INV, CM.
  prefix TEXT NOT NULL CHECK (prefix ~ '^[A-Z]{1,6}$'),
  -- The number after the letters the next one gets, unless it's taken.
  next_seq BIGINT NOT NULL CHECK (next_seq BETWEEN 1 AND 999999999),
  changed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ
);

INSERT INTO own_number_series (doc_type, prefix, next_seq) VALUES
  ('sales_order', 'SO', 10001),
  ('purchase_order', 'PO', 10001),
  ('invoice', 'INV', 10001),
  ('credit_memo', 'CM', 10001)
ON CONFLICT (doc_type) DO NOTHING;

-- ── Every number FleetSuite took ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS own_numbers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_type TEXT NOT NULL CHECK (doc_type IN ('sales_order', 'purchase_order', 'invoice', 'credit_memo')),
  number TEXT NOT NULL CHECK (number ~ '^[A-Z]{1,6}[0-9]{1,9}$'),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Who was signed in for the send; none for a scheduled job.
  reserved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- Taken and on its way to NetSuite; NetSuite made the document; NetSuite refused it, so nothing has the number;
  -- or FleetSuite never heard whether NetSuite made it.
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'made', 'refused', 'unsure')),
  settled_at TIMESTAMPTZ,
  -- What NetSuite made: its internal ID, and the number it kept when FleetSuite read it back.
  netsuite_id TEXT CHECK (netsuite_id ~ '^[0-9]{1,20}$'),
  netsuite_number TEXT CHECK (length(netsuite_number) BETWEEN 1 AND 60),
  -- NetSuite's reason for a refusal, or why FleetSuite isn't sure.
  note TEXT CHECK (length(note) BETWEEN 1 AND 600),
  -- NetSuite made the document but kept a number of its own (Allow Override off for the kind in NetSuite). A PO's
  -- customer ending after a dash is still FleetSuite's number.
  kept_own BOOLEAN GENERATED ALWAYS AS (
    status = 'made' AND netsuite_number IS NOT NULL
    AND upper(netsuite_number) <> number AND upper(netsuite_number) NOT LIKE number || '-%'
  ) STORED,
  -- When the daily check told the super admins NetSuite kept its own.
  told_at TIMESTAMPTZ,
  CONSTRAINT own_numbers_settled CHECK ((status = 'reserved') = (settled_at IS NULL)),
  CONSTRAINT own_numbers_only_made CHECK (status = 'made' OR (netsuite_id IS NULL AND netsuite_number IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS own_numbers_unique ON own_numbers (doc_type, number);
CREATE INDEX IF NOT EXISTS own_numbers_recent ON own_numbers (reserved_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS own_numbers_netsuite ON own_numbers (netsuite_id) WHERE netsuite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS own_numbers_untold ON own_numbers (reserved_at) WHERE kept_own AND told_at IS NULL;

-- The feed's sends by what they made, for own_numbers_made_outside.
CREATE INDEX IF NOT EXISTS idx_netsuite_sends_made ON netsuite_sends (made_id) WHERE made_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS own_number_outside_told (
  -- A sales order or PO made in NetSuite, not FleetSuite, the daily check told about.
  netsuite_id TEXT PRIMARY KEY CHECK (netsuite_id ~ '^[0-9]{1,20}$'),
  told_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Taking a number, and what became of it ─────────────────────────────────

-- Whether a number is FleetSuite's already or on one of NetSuite's documents in FleetSuite's copies.
CREATE OR REPLACE FUNCTION public.own_number_taken(p_type TEXT, p_number TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (SELECT 1 FROM public.own_numbers n WHERE n.doc_type = p_type AND n.number = upper(p_number))
    OR CASE p_type
      WHEN 'sales_order' THEN EXISTS (
        SELECT 1 FROM public.netsuite_sales_orders so WHERE upper(so.tranid) = upper(p_number))
      -- PO453-ACME has PO453: FleetSuite puts the customer after a dash (src/lib/po-number.ts).
      WHEN 'purchase_order' THEN EXISTS (
        SELECT 1 FROM public.netsuite_vendor_pos po
        WHERE upper(po.tranid) = upper(p_number) OR upper(po.tranid) LIKE upper(p_number) || '-%')
      WHEN 'invoice' THEN EXISTS (
        SELECT 1 FROM public.ledger_invoices li WHERE li.doc_type = 'invoice' AND lower(li.doc_number) = lower(p_number))
        OR EXISTS (SELECT 1 FROM public.gl_own_invoices oi WHERE upper(oi.netsuite_number) = upper(p_number))
      WHEN 'credit_memo' THEN EXISTS (
        SELECT 1 FROM public.ledger_invoices li WHERE li.doc_type = 'credit_memo' AND lower(li.doc_number) = lower(p_number))
        OR EXISTS (SELECT 1 FROM public.gl_own_credit_memos cm WHERE upper(cm.netsuite_number) = upper(p_number))
      ELSE false
    END
$$;

-- Takes the kind's next number nobody has, and keeps it as on its way to NetSuite.
CREATE OR REPLACE FUNCTION public.own_number_reserve(p_type TEXT, p_by UUID)
RETURNS TABLE (reserved_id UUID, reserved_number TEXT)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_prefix TEXT;
  v_seq BIGINT;
  v_number TEXT;
  v_tries INT := 0;
BEGIN
  LOOP
    -- The series row stays locked until this returns, so two at once wait their turn.
    UPDATE public.own_number_series s SET next_seq = s.next_seq + 1
    WHERE s.doc_type = p_type
    RETURNING s.prefix, s.next_seq - 1 INTO v_prefix, v_seq;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no numbers for %', p_type;
    END IF;
    v_number := v_prefix || v_seq::TEXT;
    EXIT WHEN NOT public.own_number_taken(p_type, v_number);
    v_tries := v_tries + 1;
    IF v_tries >= 10000 THEN
      RAISE EXCEPTION 'no free % number after % tries', p_type, v_tries;
    END IF;
  END LOOP;

  -- Someone with no profile left is nobody, rather than a number that can't be taken.
  INSERT INTO public.own_numbers (doc_type, number, reserved_by)
  VALUES (p_type, v_number, (SELECT p.id FROM public.profiles p WHERE p.id = p_by))
  RETURNING id, number INTO reserved_id, reserved_number;
  RETURN NEXT;
END;
$$;

-- Says what became of a number on its way to NetSuite, once: true when it was still on its way.
CREATE OR REPLACE FUNCTION public.own_number_settle(
  p_id UUID, p_status TEXT, p_netsuite_id TEXT, p_netsuite_number TEXT, p_note TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('made', 'refused', 'unsure') THEN
    RAISE EXCEPTION 'not what can become of a number: %', p_status;
  END IF;
  UPDATE public.own_numbers n SET
    status = p_status,
    settled_at = now(),
    netsuite_id = CASE WHEN p_status = 'made' AND btrim(p_netsuite_id) ~ '^[0-9]{1,20}$' THEN btrim(p_netsuite_id) END,
    netsuite_number = CASE WHEN p_status = 'made' THEN left(nullif(btrim(p_netsuite_number), ''), 60) END,
    note = left(nullif(btrim(p_note), ''), 600)
  WHERE n.id = p_id AND n.status = 'reserved';
  RETURN FOUND;
END;
$$;

-- Changes a kind's letters and next number (a super admin, on Books → Own numbers). A number already taken is
-- still passed over, so going back never gives one twice.
CREATE OR REPLACE FUNCTION public.own_number_series_set(p_type TEXT, p_prefix TEXT, p_next BIGINT, p_by UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  UPDATE public.own_number_series s SET
    prefix = upper(btrim(p_prefix)),
    next_seq = p_next,
    changed_by = p_by,
    changed_at = now()
  WHERE s.doc_type = p_type;
  RETURN FOUND;
END;
$$;

-- The sales orders and POs dated from p_since that FleetSuite didn't make, newest first, with when the daily check
-- told about each. Never before the first send the NetSuite feed kept, since what FleetSuite made before then isn't
-- in it.
CREATE OR REPLACE FUNCTION public.own_numbers_made_outside(p_since DATE, p_limit INTEGER)
RETURNS TABLE (
  netsuite_id TEXT, doc_type TEXT, tranid TEXT, trandate DATE, party TEXT, created_by_name TEXT, told_at TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH since AS (
    SELECT greatest(p_since, (SELECT (min(s.started_at) AT TIME ZONE 'America/Chicago')::date FROM public.netsuite_sends s)) AS day
  ), outside AS (
    SELECT so.netsuite_id, 'sales_order'::text AS doc_type, so.tranid, so.trandate, so.customer_name AS party, so.created_by_name
    FROM public.netsuite_sales_orders so, since
    WHERE so.trandate >= since.day
      AND NOT EXISTS (SELECT 1 FROM public.own_numbers n WHERE n.netsuite_id = so.netsuite_id AND n.doc_type = 'sales_order')
      AND NOT EXISTS (SELECT 1 FROM public.netsuite_sends s WHERE s.made_id = so.netsuite_id AND s.made_type = 'salesOrder')
    UNION ALL
    SELECT po.netsuite_id, 'purchase_order', po.tranid, po.trandate, po.vendor_name, po.created_by_name
    FROM public.netsuite_vendor_pos po, since
    WHERE po.trandate >= since.day
      AND NOT EXISTS (SELECT 1 FROM public.own_numbers n WHERE n.netsuite_id = po.netsuite_id AND n.doc_type = 'purchase_order')
      AND NOT EXISTS (SELECT 1 FROM public.netsuite_sends s WHERE s.made_id = po.netsuite_id AND s.made_type = 'purchaseOrder')
      -- A drop ship PO NetSuite made by itself for FleetSuite's sales order (migration 429).
      AND NOT EXISTS (SELECT 1 FROM public.drop_ship_orders d WHERE d.purchase_order_id = po.netsuite_id)
  )
  SELECT o.netsuite_id, o.doc_type, o.tranid, o.trandate, o.party, o.created_by_name, t.told_at
  FROM outside o
  LEFT JOIN public.own_number_outside_told t ON t.netsuite_id = o.netsuite_id
  ORDER BY o.trandate DESC, o.netsuite_id DESC
  LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

-- What the daily check tells the super admins about while FleetSuite's own numbers is on, oldest first, at most
-- p_limit of each: the numbers NetSuite didn't keep, and the sales orders and POs made in NetSuite instead from p_since,
-- that it hasn't told about yet.
CREATE OR REPLACE FUNCTION public.own_numbers_to_tell(p_since DATE, p_limit INTEGER)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'kept', coalesce((
      SELECT jsonb_agg(to_jsonb(k) ORDER BY k.reserved_at, k.id) FROM (
        SELECT n.id, n.doc_type, n.number, n.netsuite_id, n.netsuite_number, n.reserved_at
        FROM public.own_numbers n
        WHERE n.kept_own AND n.told_at IS NULL
        ORDER BY n.reserved_at, n.id
        LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
      ) k), '[]'::jsonb),
    'outside', coalesce((
      SELECT jsonb_agg(to_jsonb(o) ORDER BY o.trandate, o.netsuite_id) FROM (
        SELECT m.netsuite_id, m.doc_type, m.tranid, m.trandate, m.party, m.created_by_name
        FROM public.own_numbers_made_outside(p_since, 1000) m
        WHERE m.told_at IS NULL
        ORDER BY m.trandate, m.netsuite_id
        LIMIT greatest(1, least(coalesce(p_limit, 200), 1000))
      ) o), '[]'::jsonb)
  )
$$;

-- Marks what the daily check told about, so no later look tells about it again.
CREATE OR REPLACE FUNCTION public.own_numbers_mark_told(p_number_ids UUID[], p_outside_ids TEXT[])
RETURNS VOID
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.own_numbers SET told_at = now() WHERE id = ANY(coalesce(p_number_ids, '{}')) AND told_at IS NULL;
  INSERT INTO public.own_number_outside_told (netsuite_id)
  SELECT DISTINCT t.id FROM unnest(coalesce(p_outside_ids, '{}')) AS t(id)
  ON CONFLICT (netsuite_id) DO NOTHING;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  t TEXT;
  f TEXT;
  r TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.own_number_series', 'public.own_numbers', 'public.own_number_outside_told'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('REVOKE ALL ON TABLE %s FROM %I', t, r);
      END IF;
    END LOOP;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.own_number_taken(text, text)', 'public.own_number_reserve(text, uuid)',
    'public.own_number_settle(uuid, text, text, text, text)', 'public.own_number_series_set(text, text, bigint, uuid)',
    'public.own_numbers_made_outside(date, integer)', 'public.own_numbers_to_tell(date, integer)',
    'public.own_numbers_mark_told(uuid[], text[])'
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

COMMENT ON TABLE own_number_series IS 'Migration 497: the letters and next number of each kind FleetSuite numbers itself once FleetSuite''s own numbers is switched on: sales orders, POs, invoices and credit memos, from SO10001, PO10001, INV10001 and CM10001 (src/lib/books/own-numbers.ts). Super admins change them on Books → Own numbers. Service-role write and read.';
COMMENT ON TABLE own_numbers IS 'Migration 497: every number FleetSuite took for a document it sent to NetSuite, and what became of it: made (with NetSuite''s internal ID and the number it kept), refused, or not sure NetSuite made it. Never given twice. Service-role write and read.';
COMMENT ON TABLE own_number_outside_told IS 'Migration 497: the sales orders and POs made in NetSuite instead of FleetSuite that the daily check told the super admins about, once each. Service-role write and read.';
COMMENT ON FUNCTION public.own_number_taken(text, text) IS 'Migration 497: whether a number is FleetSuite''s already or on one of NetSuite''s documents of the kind in FleetSuite''s copies. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_number_reserve(text, uuid) IS 'Migration 497: takes the next number of a kind that nobody has and keeps it as on its way to NetSuite. Service role only.';
COMMENT ON FUNCTION public.own_number_settle(uuid, text, text, text, text) IS 'Migration 497: says what became of a number on its way to NetSuite (made, refused or not sure), once. Service role only.';
COMMENT ON FUNCTION public.own_number_series_set(text, text, bigint, uuid) IS 'Migration 497: changes a kind''s letters and next number. Service role only.';
COMMENT ON FUNCTION public.own_numbers_made_outside(date, integer) IS 'Migration 497: the sales orders and POs in FleetSuite''s copies dated from a day that FleetSuite didn''t make, newest first, with when the daily check told about each. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_numbers_to_tell(date, integer) IS 'Migration 497: the numbers NetSuite didn''t keep and the sales orders and POs made in NetSuite instead that the daily check hasn''t told about, oldest first. Reads only. Service role only.';
COMMENT ON FUNCTION public.own_numbers_mark_told(uuid[], text[]) IS 'Migration 497: marks numbers NetSuite didn''t keep, and sales orders and POs made in NetSuite instead, told about. Service role only.';
