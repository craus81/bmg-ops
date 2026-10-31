-- Migration 480: FleetSuite's own books, part 48 — FleetSuite's record of a
-- customer or a vendor wins over a change made in NetSuite, switched off
-- until it's turned on.
--
-- Owner decisions (thread "Replacing NetSuite with FleetSuite"): FleetSuite
-- is the master for customers, vendors and items from the first quarter of
-- 2027 (2026-10-09, which ends the 2026-09-21 rule that NetSuite's record is
-- the master), and from January 1, 2027 the team works only in FleetSuite,
-- apart from payments, deposits and banking (2026-10-31); each piece that
-- changes how the team works is built switched off. Once this one is on, the
-- NetSuite syncs keep the name, email, phone and billing address FleetSuite
-- has for a customer, and the name, email and phone it has for a vendor.
-- NetSuite's fills one FleetSuite has blank, and where NetSuite has something
-- else it's listed for a super admin to keep FleetSuite's, which sends it on
-- to NetSuite, or take NetSuite's (src/lib/fleetsuite-records.ts, Books →
-- Changed in NetSuite; docs/books.md "FleetSuite's record wins").
--
--   * books_switches takes an eleventh piece, fleetsuite_records, off;
--   * record_differences, one row for each field of a record where NetSuite
--     has something else. It's open until someone keeps FleetSuite's or
--     takes NetSuite's, or a sync finds the two the same again. Only one is
--     open for a field of a record at a time;
--   * note_record_differences, how a sync notes what it saw.
--
-- Writer and reader: the service role only. RLS is on with no policies,
-- and anon/authenticated have no table or function privileges.

-- ── The switch ─────────────────────────────────────────────────────────────

-- Migration 479 named the pieces in a check on the column; take whichever
-- check names them now and put back one that names all eleven.
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
                   'bill_fixes', 'customer_vendor_details', 'item_accounts', 'estimates_in_fleetsuite', 'fleetsuite_records'));

INSERT INTO books_switches (piece) VALUES ('fleetsuite_records') ON CONFLICT (piece) DO NOTHING;

-- ── What NetSuite has instead ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS record_differences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- An item's fields join in a later part.
  kind TEXT NOT NULL CHECK (kind IN ('customer', 'vendor', 'item')),
  netsuite_id TEXT NOT NULL CHECK (netsuite_id ~ '^[0-9]+$'),
  -- The record's name as FleetSuite has it, for the list.
  name TEXT CHECK (length(name) <= 300),
  -- Which of the record's fields: the app names them (FIELDS in src/lib/fleetsuite-records.ts).
  field TEXT NOT NULL CHECK (field ~ '^[a-z_]{1,40}$'),
  -- Each side's value as the sync saw it: text, or an address's lines; none when that side has none.
  fleetsuite_value JSONB CHECK (length(fleetsuite_value::text) <= 4000),
  netsuite_value JSONB CHECK (length(netsuite_value::text) <= 4000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'kept', 'taken', 'same')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Kept: whether FleetSuite's went on to NetSuite. None unless it was kept.
  sent_to_netsuite BOOLEAN,
  closed_at TIMESTAMPTZ,
  -- Who kept or took it; a sync closes one that's the same again.
  closed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  -- When the daily check told the super admins about it.
  told_at TIMESTAMPTZ,
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'kept') = (sent_to_netsuite IS NOT NULL)),
  CHECK (status IN ('kept', 'taken') OR closed_by IS NULL)
);
-- One open for a field of a record at a time.
CREATE UNIQUE INDEX IF NOT EXISTS record_differences_one_open ON record_differences (kind, netsuite_id, field) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS record_differences_list_idx ON record_differences (status, last_seen_at DESC, id);
CREATE INDEX IF NOT EXISTS record_differences_field_idx ON record_differences (kind, netsuite_id, field, closed_at DESC);

-- What a sync saw of the records it read. p: [{ kind, netsuite_id, name?, field, fleetsuite, netsuite, differs }]
-- One that differs is listed: its open row takes what was seen now, or a row opens, unless FleetSuite's was last
-- kept without being sent to NetSuite and NetSuite still has what it had then. One that doesn't differ closes its
-- open row as the same. Returns { opened, closed }.
CREATE OR REPLACE FUNCTION public.note_record_differences(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  e JSONB;
  v_kind TEXT;
  v_ns TEXT;
  v_field TEXT;
  v_name TEXT;
  v_fleetsuite JSONB;
  v_netsuite JSONB;
  v_last public.record_differences;
  v_new BOOLEAN;
  v_opened INTEGER := 0;
  v_closed INTEGER := 0;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'record differences: a list of what was seen, not %', coalesce(jsonb_typeof(p), '(nothing)');
  END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p) LOOP
    v_kind := e->>'kind';
    v_ns := e->>'netsuite_id';
    v_field := e->>'field';
    v_name := left(nullif(btrim(e->>'name'), ''), 300);
    -- A side that has none is kept as none, not as JSON's null.
    v_fleetsuite := nullif(e->'fleetsuite', 'null'::jsonb);
    v_netsuite := nullif(e->'netsuite', 'null'::jsonb);
    IF jsonb_typeof(e->'differs') IS DISTINCT FROM 'boolean' THEN
      RAISE EXCEPTION 'record differences: whether % % differs wasn''t said', coalesce(v_kind, '(nothing)'), coalesce(v_field, '(nothing)');
    END IF;

    IF (e->>'differs')::boolean THEN
      UPDATE public.record_differences
      SET name = coalesce(v_name, name), fleetsuite_value = v_fleetsuite, netsuite_value = v_netsuite, last_seen_at = now()
      WHERE kind = v_kind AND netsuite_id = v_ns AND field = v_field AND status = 'open';
      CONTINUE WHEN FOUND;

      SELECT * INTO v_last FROM public.record_differences
      WHERE kind = v_kind AND netsuite_id = v_ns AND field = v_field
      ORDER BY closed_at DESC, id DESC
      LIMIT 1;
      CONTINUE WHEN FOUND AND v_last.status = 'kept' AND v_last.sent_to_netsuite = false
        AND v_last.netsuite_value IS NOT DISTINCT FROM v_netsuite;

      INSERT INTO public.record_differences (kind, netsuite_id, name, field, fleetsuite_value, netsuite_value)
      VALUES (v_kind, v_ns, v_name, v_field, v_fleetsuite, v_netsuite)
      ON CONFLICT (kind, netsuite_id, field) WHERE status = 'open' DO UPDATE
        SET name = coalesce(EXCLUDED.name, record_differences.name), fleetsuite_value = EXCLUDED.fleetsuite_value,
            netsuite_value = EXCLUDED.netsuite_value, last_seen_at = now()
      RETURNING (xmax = 0) INTO v_new;
      IF v_new THEN
        v_opened := v_opened + 1;
      END IF;
    ELSE
      UPDATE public.record_differences
      SET status = 'same', closed_at = now(), last_seen_at = now()
      WHERE kind = v_kind AND netsuite_id = v_ns AND field = v_field AND status = 'open';
      IF FOUND THEN
        v_closed := v_closed + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('opened', v_opened, 'closed', v_closed);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  ALTER TABLE public.record_differences ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.record_differences FROM %I', r);
      EXECUTE format('REVOKE ALL ON FUNCTION public.note_record_differences(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  REVOKE ALL ON FUNCTION public.note_record_differences(jsonb) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.note_record_differences(jsonb) TO service_role;
  END IF;
END $$;

COMMENT ON TABLE record_differences IS 'Migration 480: once FleetSuite''s record wins (books switch fleetsuite_records), one row for each field of a customer or vendor where NetSuite has something else than FleetSuite (src/lib/fleetsuite-records.ts): open until a super admin keeps FleetSuite''s (sent on to NetSuite) or takes NetSuite''s, or a sync finds the two the same again. One open for a field of a record at a time. Service-role write and read.';
COMMENT ON FUNCTION public.note_record_differences(jsonb) IS 'Migration 480: notes what a NetSuite sync saw of a record''s fields, opening or updating a row where NetSuite has something else and closing one that''s the same again. Service role only.';
