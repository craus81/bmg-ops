-- Migration 484: FleetSuite's own books, part 53 — the CPA's own adjustments
-- journal, on the journal entries typed in FleetSuite (migration 469).
--
-- Part 52 (migration 483) gave the CPA a login that reads every Books page and
-- changes nothing there. The NetSuite Exit Checklist's "Bookkeeper and CPA
-- access" asks for one more thing: the CPA posts, but only to its own
-- adjustments journal (docs/books.md "The CPA's adjustments journal"). A typed
-- journal entry now belongs to one of two journals:
--   * general — the entries the bookkeeper and BMG's staff type, as before;
--   * cpa_adjustments — the CPA's adjustments (depreciation, loan interest,
--     year-end entries), typed by the CPA or by a super admin for them.
-- Who types in which, and so sees it, is journalsFor in
-- src/lib/typed-journal-entries.ts, checked by /api/journal-entries on every
-- step. Each is still asked for approval and approved by a super admin who
-- didn't ask, and made in NetSuite once, its memo starting "CPA adjustment:"
-- so it reads as the CPA's in NetSuite and in the books.
--
-- Two changes here:
--   1. typed_journal_entries takes the journal each entry is in, general for
--      every entry typed until now.
--   2. typed_journal_entry_save (migration 469) replaced, the same function
--      with one addition: a new entry starts in the journal it's saved in,
--      and an entry stays in the journal it started in. Saving it as
--      another journal's changes nothing and answers 'other_journal'.
--
-- Writer and reader: the service role only, as before.

ALTER TABLE typed_journal_entries ADD COLUMN IF NOT EXISTS journal TEXT NOT NULL DEFAULT 'general'
  CHECK (journal IN ('general', 'cpa_adjustments'));

COMMENT ON COLUMN typed_journal_entries.journal IS
  'Migration 484: the journal the entry is in, from when it''s started: general, typed by the bookkeeper and staff; cpa_adjustments, the CPA''s own adjustments, typed by the CPA or a super admin for them (journalsFor in src/lib/typed-journal-entries.ts).';

-- Saves a draft, new or changed. p:
--   { id, journal?, company, tran_date, memo?, lines: [{ account_netsuite_id?, debit_cents, credit_cents, memo? }], by? }
-- journal is general (the default) or cpa_adjustments: a new entry starts in it, and an entry in another journal isn't
-- changed. A line's account is NetSuite's id, or none yet; its amounts are whole cents, $0 or more. Only a draft
-- changes: an entry asked for approval, being made or made stays as it is.
-- Returns { saved, status, updated_at } — status 'other_journal', with the journal it's in, when it's another's.
CREATE OR REPLACE FUNCTION public.typed_journal_entry_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID := (p->>'id')::uuid;
  v_journal TEXT := coalesce(nullif(btrim(coalesce(p->>'journal', '')), ''), 'general');
  v_lines JSONB := coalesce(p->'lines', '[]'::jsonb);
  v_kept JSONB;
  v_total BIGINT;
  v_row public.typed_journal_entries;
BEGIN
  IF v_journal NOT IN ('general', 'cpa_adjustments') THEN
    RAISE EXCEPTION 'typed journal entries: there''s no % journal', v_journal;
  END IF;
  IF jsonb_typeof(v_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'typed journal entries: an entry''s lines must be a list';
  END IF;
  IF jsonb_array_length(v_lines) > 200 THEN
    RAISE EXCEPTION 'typed journal entries: an entry takes 200 lines at most';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_lines) AS x(v)
    WHERE jsonb_typeof(x.v) IS DISTINCT FROM 'object'
       OR coalesce(jsonb_typeof(x.v->'account_netsuite_id'), 'null') NOT IN ('null', 'string')
       OR (jsonb_typeof(x.v->'account_netsuite_id') = 'string' AND (x.v->>'account_netsuite_id') !~ '^[0-9]+$')
       OR jsonb_typeof(x.v->'debit_cents') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x.v->'credit_cents') IS DISTINCT FROM 'number'
       OR (x.v->>'debit_cents')::numeric < 0 OR (x.v->>'credit_cents')::numeric < 0
       OR (x.v->>'debit_cents')::numeric <> trunc((x.v->>'debit_cents')::numeric)
       OR (x.v->>'credit_cents')::numeric <> trunc((x.v->>'credit_cents')::numeric)
       OR (x.v->>'debit_cents')::numeric > 10000000000 OR (x.v->>'credit_cents')::numeric > 10000000000
       OR length(coalesce(x.v->>'memo', '')) > 300
  ) THEN
    RAISE EXCEPTION 'typed journal entries: each line is an account (NetSuite''s id) and whole cents of $0 or more';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_netsuite_id', x.v->>'account_netsuite_id',
           'debit_cents', (x.v->>'debit_cents')::bigint,
           'credit_cents', (x.v->>'credit_cents')::bigint,
           'memo', nullif(btrim(coalesce(x.v->>'memo', '')), '')
         ) ORDER BY x.n), '[]'::jsonb),
         coalesce(sum((x.v->>'debit_cents')::bigint), 0)
  INTO v_kept, v_total
  FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS x(v, n);

  INSERT INTO public.typed_journal_entries (id, journal, company, tran_date, memo, lines, total_cents, created_by, updated_by)
  VALUES (v_id, v_journal, btrim(p->>'company'), (p->>'tran_date')::date, nullif(btrim(coalesce(p->>'memo', '')), ''), v_kept, v_total,
          nullif(p->>'by', '')::uuid, nullif(p->>'by', '')::uuid)
  ON CONFLICT (id) DO NOTHING
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;

  SELECT * INTO v_row FROM public.typed_journal_entries WHERE id = v_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Deleted between the two.
    RETURN jsonb_build_object('saved', false, 'status', 'gone');
  END IF;
  IF v_row.journal <> v_journal THEN
    RETURN jsonb_build_object('saved', false, 'status', 'other_journal', 'journal', v_row.journal, 'updated_at', v_row.updated_at);
  END IF;
  IF v_row.status <> 'draft' THEN
    RETURN jsonb_build_object('saved', false, 'status', v_row.status, 'updated_at', v_row.updated_at);
  END IF;
  UPDATE public.typed_journal_entries
  SET company = btrim(p->>'company'), tran_date = (p->>'tran_date')::date, memo = nullif(btrim(coalesce(p->>'memo', '')), ''),
      lines = v_kept, total_cents = v_total, updated_by = nullif(p->>'by', '')::uuid, updated_at = now()
  WHERE id = v_id
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('saved', true, 'status', v_row.status, 'updated_at', v_row.updated_at);
END;
$$;

-- ── Access: service role only, as migration 469 left it ────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.typed_journal_entry_save(jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.typed_journal_entry_save(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.typed_journal_entry_save(jsonb) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.typed_journal_entry_save(jsonb) IS 'Migrations 469 and 484: saves a draft journal entry, new or changed, in the journal it started in; an entry asked for approval or made, or in another journal, stays as it is. Service role only.';
COMMENT ON TABLE typed_journal_entries IS 'Migrations 469 and 484: one row per journal entry typed on the Journal entries page (src/lib/typed-journal-entries.ts, /api/journal-entries), in the general journal or the CPA''s adjustments journal: its lines as typed, who asked for approval, who sent it back and why, who approved it, and the journal entry NetSuite made (its External ID is fleetsuite-je- and this id). Moved only by its functions. Service-role write and read.';
