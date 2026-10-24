-- Migration 431: FleetSuite's own books — mistake checks. Each night Books
-- looks through the bills, checks and card charges it copies from NetSuite
-- for likely mistakes, and lists each one, with why, for a super admin to
-- clear.
--
-- Owner decision 2026-10-24 (thread "Replacing NetSuite with FleetSuite",
-- "Mistake checks"; the owner OK'd the preview on Books Previews): an idea
-- borrowed from bookkeeping software, built next to the crossover. Four kinds
-- (src/lib/books/mistake-checks.ts, docs/books.md "Mistake checks"): entered
-- twice, far off the vendor's usual, a monthly charge missing, and a line
-- coded to an account the vendor's earlier documents never used. It flags
-- what's dated from September 1, 2026, and works out what's usual from
-- everything the copies hold, since January 2025. Nothing here changes
-- NetSuite or the books.
--   * gl_mistake_checks, each likely mistake, kept by the key the check finds
--     it by. It's open until a super admin clears it, as fixed in NetSuite or
--     fine as it is (which can also teach the check), or until the copies no
--     longer show it, when it clears on its own. One cleared as fixed comes
--     back if the check still finds it once the copies have NetSuite's fix;
--   * gl_mistake_docs(from, to), the copied bills, checks and card charges
--     dated in those days, each with the companies its GL lines post to and
--     the accounts its expense lines are coded to;
--   * gl_mistake_checks_save(p), what one look found, applied at once;
--   * gl_mistake_check_clear(p) and gl_mistake_check_reopen(p), a super
--     admin clearing one and opening it again.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- ── Table ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS gl_mistake_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- How the check finds it again from one look to the next: '<kind>:<what it's about>' (mistake-checks.ts).
  key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('twice', 'far_off', 'missing', 'odd_account')),
  company_id UUID NOT NULL REFERENCES gl_companies(id) ON DELETE RESTRICT,
  -- The vendor or payee, by NetSuite's id, and its name as the copies had it.
  party_netsuite_id TEXT CHECK (party_netsuite_id ~ '^[0-9]+$'),
  party_name TEXT,
  -- The document's date; for a monthly charge missing, the first of the month it's missing for.
  doc_date DATE NOT NULL,
  -- The amount, or about what the missing charge comes to.
  amount NUMERIC(16,2),
  -- How likely a mistake it is next to others of its kind, the likeliest highest.
  strength SMALLINT NOT NULL DEFAULT 0,
  why TEXT NOT NULL CHECK (btrim(why) <> ''),
  -- The documents it's about: [{ netsuite_id, type, number, date, total, label }].
  docs JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(docs) = 'array'),
  -- What clearing it as fine can also teach the check: { party, accounts } for an odd account, { party, company } for a
  -- monthly charge. NULL for the other kinds.
  learn JSONB CHECK (learn IS NULL OR jsonb_typeof(learn) = 'object'),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'cleared')),
  -- 'fixed': in NetSuite, as a super admin said. 'fine': as it is, as a super admin said. 'gone': on its own, once the
  -- copies no longer showed it.
  cleared_how TEXT CHECK (cleared_how IN ('fixed', 'fine', 'gone')),
  cleared_by UUID,
  cleared_at TIMESTAMPTZ,
  cleared_note TEXT,
  -- What changed, when it cleared on its own.
  gone_why TEXT,
  -- Cleared as fine and teaching the check: the accounts are fine for the vendor, or the monthly charge isn't watched.
  learned BOOLEAN NOT NULL DEFAULT false,
  -- When it last came back: found again once the copies had NetSuite's fix, or after it had cleared on its own.
  back_at TIMESTAMPTZ,
  found_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The last look that found it.
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (split_part(key, ':', 1) = kind AND length(key) > length(kind) + 1),
  CHECK ((state = 'cleared') = (cleared_how IS NOT NULL)),
  CHECK ((state = 'cleared') = (cleared_at IS NOT NULL)),
  CHECK (NOT learned OR (cleared_how = 'fine' AND learn IS NOT NULL)),
  CHECK (cleared_by IS NULL OR cleared_how IN ('fixed', 'fine'))
);
CREATE INDEX IF NOT EXISTS idx_gl_mistake_checks_state ON gl_mistake_checks(state, company_id);

-- ── What the check looks through ───────────────────────────────────────────

-- The copied bills and bill credits (migration 384) and checks and card
-- charges and refunds (migration 391) dated from p_from up to p_to, those
-- NetSuite still has, oldest first, each with:
--   companies: the companies its GL lines post to (migration 361), none until
--              the copy of NetSuite's ledger has it;
--   accounts:  the accounts its expense lines are coded to, tax lines left
--              out, item lines too: an item's account comes with the item;
--   lines_known: false while the copy couldn't read its lines.
-- The vendor's name is the vendors list's (migration 363), else the copy's.
CREATE OR REPLACE FUNCTION public.gl_mistake_docs(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH docs AS (
    SELECT b.netsuite_id, b.tran_type, b.tranid, b.trandate, b.vendor_netsuite_id AS party,
           coalesce(v.name, b.vendor_name) AS party_name, b.total, b.voided, b.lines
    FROM public.gl_netsuite_bills b
    LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = b.vendor_netsuite_id
    WHERE b.gone_at IS NULL
      AND b.trandate >= p_from
      AND b.trandate < p_to
    UNION ALL
    SELECT s.netsuite_id, s.tran_type, s.tranid, s.trandate, s.payee_netsuite_id,
           coalesce(v.name, s.payee_name), s.total, s.voided, s.lines
    FROM public.gl_netsuite_spending s
    LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = s.payee_netsuite_id
    WHERE s.gone_at IS NULL
      AND s.trandate >= p_from
      AND s.trandate < p_to
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'netsuite_id', d.netsuite_id,
    'type', d.tran_type,
    'number', d.tranid,
    'date', to_char(d.trandate, 'YYYY-MM-DD'),
    'party', d.party,
    'name', d.party_name,
    'total', d.total::text,
    'voided', d.voided,
    'companies', (
      SELECT coalesce(jsonb_agg(DISTINCT c.code ORDER BY c.code), '[]'::jsonb)
      FROM public.gl_netsuite_lines l
      JOIN public.gl_companies c ON c.id = l.company_id
      WHERE l.transaction_id = d.netsuite_id
    ),
    'accounts', (
      SELECT coalesce(jsonb_agg(DISTINCT l.line->>'account' ORDER BY l.line->>'account'), '[]'::jsonb)
      FROM jsonb_array_elements(coalesce(d.lines, '[]'::jsonb)) AS l(line)
      WHERE jsonb_typeof(l.line) = 'object'
        AND l.line->>'item' IS NULL
        AND l.line->>'account' IS NOT NULL
        AND l.line->>'tax' IS DISTINCT FROM 'true'
    ),
    'lines_known', d.lines IS NOT NULL
  ) ORDER BY d.trandate, d.netsuite_id::bigint), '[]'::jsonb)
  FROM docs d
$$;

-- ── The look's writer ──────────────────────────────────────────────────────

-- Applies what one look found. p:
--   { found: [{ key, kind, company ('BMG'), party?, party_name?, date, amount?, strength?, why, docs, learn? }],
--     gone?: [{ key, why }],
--     copied_through?: when the copies last had all of NetSuite's changes, the older of the bills' and the checks' }
-- A key not kept yet is added, open. One kept and open is brought up to date.
-- One cleared on its own is open again, and so is one cleared as fixed before
-- copied_through: the copies have NetSuite's fix and the check still finds
-- it. Either is marked back. One cleared as fine, or as fixed after
-- copied_through, stays as it was cleared. An open one the look didn't find
-- clears on its own, with gone's why for it. All of it applies or none does.
-- Returns { found, added, back, gone }.
CREATE OR REPLACE FUNCTION public.gl_mistake_checks_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_bad TEXT;
  v_through TIMESTAMPTZ;
  v_found INTEGER;
  v_added INTEGER;
  v_back INTEGER;
  v_gone INTEGER;
BEGIN
  IF jsonb_typeof(p->'found') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: found must be a list';
  END IF;
  IF p ? 'gone' AND jsonb_typeof(p->'gone') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: gone must be a list';
  END IF;
  v_through := nullif(p->>'copied_through', '')::timestamptz;
  -- One look at a time: the night's look and "Look now" can land together.
  PERFORM pg_advisory_xact_lock(hashtext('gl_mistake_checks'));

  SELECT x.v->>'key' INTO v_bad
  FROM jsonb_array_elements(p->'found') AS x(v)
  GROUP BY x.v->>'key'
  HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: % is in the look twice', v_bad;
  END IF;
  SELECT coalesce(x.v->>'key', '(none)') INTO v_bad
  FROM jsonb_array_elements(p->'found') AS x(v)
  WHERE coalesce(x.v->>'kind', '') NOT IN ('twice', 'far_off', 'missing', 'odd_account')
     OR split_part(coalesce(x.v->>'key', ''), ':', 1) IS DISTINCT FROM x.v->>'kind'
     OR length(coalesce(x.v->>'key', '')) <= length(x.v->>'kind') + 1
     OR coalesce(x.v->>'party', '') !~ '^([0-9]+)?$'
     OR nullif(x.v->>'date', '') IS NULL
     OR coalesce(btrim(x.v->>'why'), '') = ''
     OR jsonb_typeof(x.v->'docs') IS DISTINCT FROM 'array'
     OR (x.v ? 'learn' AND jsonb_typeof(x.v->'learn') NOT IN ('object', 'null'))
     OR NOT EXISTS (SELECT 1 FROM public.gl_companies c WHERE c.code = x.v->>'company')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: % isn''t a mistake the check can keep', v_bad;
  END IF;

  WITH incoming AS (
    SELECT x.v->>'key' AS key,
           x.v->>'kind' AS kind,
           c.id AS company_id,
           nullif(x.v->>'party', '') AS party,
           nullif(btrim(x.v->>'party_name'), '') AS party_name,
           (x.v->>'date')::date AS doc_date,
           nullif(x.v->>'amount', '')::numeric(16,2) AS amount,
           coalesce(nullif(x.v->>'strength', '')::smallint, 0) AS strength,
           btrim(x.v->>'why') AS why,
           x.v->'docs' AS docs,
           CASE WHEN jsonb_typeof(x.v->'learn') = 'object' THEN x.v->'learn' END AS learn
    FROM jsonb_array_elements(p->'found') AS x(v)
    JOIN public.gl_companies c ON c.code = x.v->>'company'
  ),
  kept AS (
    UPDATE public.gl_mistake_checks m
    SET company_id = i.company_id, party_netsuite_id = i.party, party_name = i.party_name, doc_date = i.doc_date,
        amount = i.amount, strength = i.strength, why = i.why, docs = i.docs, learn = i.learn, seen_at = now()
    FROM incoming i
    WHERE m.key = i.key
      AND m.state = 'open'
    RETURNING m.id
  ),
  back AS (
    UPDATE public.gl_mistake_checks m
    SET company_id = i.company_id, party_netsuite_id = i.party, party_name = i.party_name, doc_date = i.doc_date,
        amount = i.amount, strength = i.strength, why = i.why, docs = i.docs, learn = i.learn, seen_at = now(),
        state = 'open', cleared_how = NULL, cleared_by = NULL, cleared_at = NULL, cleared_note = NULL, gone_why = NULL,
        learned = false, back_at = now()
    FROM incoming i
    WHERE m.key = i.key
      AND m.state = 'cleared'
      AND (m.cleared_how = 'gone' OR (m.cleared_how = 'fixed' AND m.cleared_at < v_through))
    RETURNING m.id
  ),
  gone AS (
    UPDATE public.gl_mistake_checks m
    SET state = 'cleared', cleared_how = 'gone', cleared_at = now(), cleared_by = NULL, cleared_note = NULL,
        gone_why = coalesce(
          (SELECT nullif(btrim(g.v->>'why'), '') FROM jsonb_array_elements(coalesce(p->'gone', '[]'::jsonb)) AS g(v)
           WHERE g.v->>'key' = m.key LIMIT 1),
          'The copies of NetSuite no longer show it.'),
        learned = false
    WHERE m.state = 'open'
      AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.key = m.key)
    RETURNING m.id
  ),
  added AS (
    INSERT INTO public.gl_mistake_checks (key, kind, company_id, party_netsuite_id, party_name, doc_date, amount, strength,
                                          why, docs, learn)
    SELECT i.key, i.kind, i.company_id, i.party, i.party_name, i.doc_date, i.amount, i.strength, i.why, i.docs, i.learn
    FROM incoming i
    WHERE NOT EXISTS (SELECT 1 FROM public.gl_mistake_checks m WHERE m.key = i.key)
    RETURNING id
  )
  -- Each update runs whether or not it's read here, and they touch different rows: open ones found, cleared ones
  -- found, open ones not found, and keys not kept yet.
  SELECT (SELECT count(*) FROM incoming), (SELECT count(*) FROM added), (SELECT count(*) FROM back), (SELECT count(*) FROM gone)
  INTO v_found, v_added, v_back, v_gone;

  RETURN jsonb_build_object('found', v_found, 'added', v_added, 'back', v_back, 'gone', v_gone);
END;
$$;

-- ── A super admin's clear, and "Open it again" ─────────────────────────────

-- Clears one open item. p: { id, how: 'fixed' | 'fine', note?, learn?, by? }
-- learn, with 'fine', also teaches the check what the item can teach it (its
-- learn): the accounts are fine for that vendor from now on, or that monthly
-- charge isn't watched. Returns the item's id and how it's cleared.
CREATE OR REPLACE FUNCTION public.gl_mistake_check_clear(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
  v_how TEXT := p->>'how';
  v_learned BOOLEAN;
BEGIN
  IF coalesce(p->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'gl: there''s no such mistake to clear';
  END IF;
  IF v_how IS NULL OR v_how NOT IN ('fixed', 'fine') THEN
    RAISE EXCEPTION 'gl: a mistake clears as fixed or fine';
  END IF;
  IF coalesce(p->>'by', '') !~* '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$' THEN
    RAISE EXCEPTION 'gl: who cleared it isn''t a user';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_mistake_checks'));

  UPDATE public.gl_mistake_checks
  SET state = 'cleared', cleared_how = v_how, cleared_at = now(), cleared_by = nullif(p->>'by', '')::uuid,
      cleared_note = nullif(btrim(p->>'note'), ''), gone_why = NULL,
      learned = (v_how = 'fine' AND coalesce(p->>'learn', 'false') = 'true' AND learn IS NOT NULL)
  WHERE id = (p->>'id')::uuid
    AND state = 'open'
  RETURNING id, learned INTO v_id, v_learned;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.gl_mistake_checks WHERE id = (p->>'id')::uuid) THEN
      RAISE EXCEPTION 'gl: it''s already cleared';
    END IF;
    RAISE EXCEPTION 'gl: there''s no such mistake to clear';
  END IF;
  RETURN jsonb_build_object('id', v_id, 'how', v_how, 'learned', v_learned);
END;
$$;

-- Opens one cleared item again, and unlearns what clearing it taught the
-- check. p: { id }. Returns its id. The next look clears it on its own again
-- if the copies no longer show it.
CREATE OR REPLACE FUNCTION public.gl_mistake_check_reopen(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF coalesce(p->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'gl: there''s no such mistake to open again';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('gl_mistake_checks'));

  UPDATE public.gl_mistake_checks
  SET state = 'open', cleared_how = NULL, cleared_by = NULL, cleared_at = NULL, cleared_note = NULL, gone_why = NULL,
      learned = false, back_at = NULL
  WHERE id = (p->>'id')::uuid
    AND state = 'cleared'
  RETURNING id INTO v_id;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.gl_mistake_checks WHERE id = (p->>'id')::uuid) THEN
      RAISE EXCEPTION 'gl: it''s already open';
    END IF;
    RAISE EXCEPTION 'gl: there''s no such mistake to open again';
  END IF;
  RETURN jsonb_build_object('id', v_id);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_mistake_checks ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_mistake_checks FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_mistake_docs(date, date)',
    'public.gl_mistake_checks_save(jsonb)',
    'public.gl_mistake_check_clear(jsonb)',
    'public.gl_mistake_check_reopen(jsonb)'
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

COMMENT ON TABLE gl_mistake_checks IS 'Migration 431: each likely mistake the nightly mistake checks found in the copies of NetSuite''s bills, checks and card charges (src/lib/books/mistake-checks.ts), by the key the check finds it by, open until a super admin clears it or the copies no longer show it. Written only by gl_mistake_checks_save, gl_mistake_check_clear and gl_mistake_check_reopen. Service-role write and read.';
COMMENT ON COLUMN gl_mistake_checks.key IS 'How the check finds it again: ''twice:<id>+<id>'', ''far_off:<id>'', ''odd_account:<id>'' by NetSuite''s ids for the documents, or ''missing:<company>:<vendor>:<YYYY-MM>''.';
COMMENT ON COLUMN gl_mistake_checks.learn IS 'What clearing it as fine can also teach the check: {party, accounts} (those accounts are fine for that vendor) for an odd account, {party, company} (stop watching that monthly charge) for a monthly charge missing.';
COMMENT ON COLUMN gl_mistake_checks.cleared_how IS '''fixed'': fixed in NetSuite, as a super admin said; it comes back if the check still finds it once the copies have the fix. ''fine'': fine as it is, as a super admin said. ''gone'': cleared on its own once the copies no longer showed it (gone_why says what changed).';
COMMENT ON COLUMN gl_mistake_checks.learned IS 'Cleared as fine with "from now on": the check holds learn until the item is opened again.';
COMMENT ON FUNCTION public.gl_mistake_docs(date, date) IS 'Migration 431: the copied bills, bill credits, checks and card charges and refunds dated in some days that NetSuite still has, each with the companies its GL lines post to and the accounts its expense lines are coded to, for the mistake checks. Service role only.';
COMMENT ON FUNCTION public.gl_mistake_checks_save(jsonb) IS 'Migration 431: applies what one look of the mistake checks found: new ones added, open ones brought up to date, ones cleared on their own or as fixed (once the copies have the fix) back, open ones not found cleared on their own. Service role only.';
COMMENT ON FUNCTION public.gl_mistake_check_clear(jsonb) IS 'Migration 431: a super admin clears one open mistake as fixed in NetSuite or fine as it is, with a note, and as fine can teach the check. Service role only.';
COMMENT ON FUNCTION public.gl_mistake_check_reopen(jsonb) IS 'Migration 431: opens one cleared mistake again and unlearns what clearing it taught the check. Service role only.';
