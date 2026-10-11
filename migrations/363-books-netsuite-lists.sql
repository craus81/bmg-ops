-- Migration 363: FleetSuite's own books, part 4 — the NetSuite lists the
-- posting rules need, copied and kept in step.
--
-- Owner decision 2026-10-11 (thread "Replacing NetSuite with FleetSuite"):
-- before FleetSuite posts entries of its own, copy NetSuite's locations,
-- departments, classes, terms and tax codes, plus the accounts each item and
-- vendor posts to, so the posting rules can pick the same accounts NetSuite
-- does. Every two hours the ledger mirror cron reads them right after the
-- chart of accounts, and "Sync now" on the Books lists page does the same.
--
-- Like the GL copy (migration 361), this follows NetSuite. NetSuite stays
-- the only place these are changed until the changeover, and FleetSuite
-- never writes one back. src/lib/books/netsuite-lists.ts is the only writer.
-- It hands each list over in pages (gl_netsuite_lists_apply), then, once a
-- list has been read whole, marks what NetSuite no longer has
-- (gl_netsuite_lists_finish). A row is never deleted: gone_at records when
-- it left NetSuite, and it comes back if NetSuite lists it again.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

CREATE TABLE IF NOT EXISTS gl_netsuite_lists (
  kind TEXT NOT NULL CHECK (kind IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item')),
  netsuite_id TEXT NOT NULL CHECK (netsuite_id ~ '^[0-9]+$'),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  parent_netsuite_id TEXT CHECK (parent_netsuite_id ~ '^[0-9]+$'),
  active BOOLEAN NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  gone_at TIMESTAMPTZ,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, netsuite_id)
);

-- Applies one page of one NetSuite list. p:
--   { kind: 'location' | 'department' | 'class' | 'term' | 'tax_code' | 'vendor' | 'item',
--     rows: [{ netsuite_id, name, parent_netsuite_id?, active, details? }] }
-- A new row is added. A row whose name, parent, active flag or details
-- differ is updated, and one that had gone from NetSuite is back. The whole
-- page applies or none of it does. Returns { received, added, changed }.
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
  IF v_kind IS NULL OR v_kind NOT IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item') THEN
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

-- Once a list has been read whole, marks the rows NetSuite no longer has as
-- gone. A list that looks cut short (none, or under half of the rows still
-- here) marks nothing and says so. p:
--   { kind, netsuite_ids: [every id NetSuite listed] }
-- Returns { listed, here, gone, cut_short }.
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
  IF v_kind IS NULL OR v_kind NOT IN ('location', 'department', 'class', 'term', 'tax_code', 'vendor', 'item') THEN
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

-- What the Books lists page shows besides the rows themselves:
--   counts:   per list, how many NetSuite has (active or not) and how many left
--   usage:    how many copied GL lines (migration 361) carry each location,
--             department and class; netsuite_id NULL counts the lines with
--             none, and kind 'all' is every copied line
--   accounts: which accounts the active items and vendors post to, counted
--             by item type (NULL account = none set)
CREATE OR REPLACE FUNCTION public.gl_netsuite_lists_overview()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'counts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('kind', c.kind, 'listed', c.listed, 'active', c.active, 'gone', c.gone) ORDER BY c.kind), '[]'::jsonb)
      FROM (
        SELECT kind,
               count(*) FILTER (WHERE gone_at IS NULL) AS listed,
               count(*) FILTER (WHERE gone_at IS NULL AND active) AS active,
               count(*) FILTER (WHERE gone_at IS NOT NULL) AS gone
        FROM public.gl_netsuite_lists
        GROUP BY kind
      ) c
    ),
    'usage', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('kind', u.kind, 'netsuite_id', u.netsuite_id, 'lines', u.lines)), '[]'::jsonb)
      FROM (
        SELECT CASE WHEN GROUPING(location_id) = 0 THEN 'location'
                    WHEN GROUPING(department_id) = 0 THEN 'department'
                    WHEN GROUPING(class_id) = 0 THEN 'class'
                    ELSE 'all' END AS kind,
               CASE WHEN GROUPING(location_id) = 0 THEN location_id
                    WHEN GROUPING(department_id) = 0 THEN department_id
                    ELSE class_id END AS netsuite_id,
               count(*) AS lines
        FROM public.gl_netsuite_lines
        GROUP BY GROUPING SETS ((location_id), (department_id), (class_id), ())
      ) u
    ),
    'accounts', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'kind', a.kind, 'field', a.field, 'netsuite_account_id', a.account, 'item_type', a.item_type, 'rows', a.n)), '[]'::jsonb)
      FROM (
        SELECT l.kind, f.field, l.details->>f.field AS account, l.details->>'item_type' AS item_type, count(*) AS n
        FROM public.gl_netsuite_lists l
        JOIN (VALUES ('item', 'income_account'), ('item', 'cogs_account'), ('item', 'asset_account'),
                     ('item', 'expense_account'), ('vendor', 'expense_account'), ('vendor', 'payables_account'))
          AS f(kind, field) ON f.kind = l.kind
        WHERE l.gone_at IS NULL AND l.active
        GROUP BY l.kind, f.field, l.details->>f.field, l.details->>'item_type'
      ) a
    )
  );
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_lists ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_lists FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_netsuite_lists_apply(jsonb)',
    'public.gl_netsuite_lists_finish(jsonb)',
    'public.gl_netsuite_lists_overview()'
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

COMMENT ON TABLE gl_netsuite_lists IS 'Migration 363: NetSuite''s locations, departments, classes, terms, tax codes, vendors and items as the books need them, copied every two hours by src/lib/books/netsuite-lists.ts. A copy that follows NetSuite until the changeover. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_lists.kind IS 'Which NetSuite list: location, department, class, term, tax_code (NetSuite''s sales tax items), vendor or item.';
COMMENT ON COLUMN gl_netsuite_lists.netsuite_id IS 'NetSuite''s internal id; gl_netsuite_lines.location_id, department_id and class_id point here.';
COMMENT ON COLUMN gl_netsuite_lists.details IS 'What else the list holds, by kind, keys present only when NetSuite gave a value. location: full_name, subsidiary_id. department, class: full_name. term: days_until_net_due, discount_percent, discount_days. tax_code: description, rate, tax_type, tax_agency_id. vendor: entity_id, expense_account, payables_account, terms_id. item: item_type, display_name, income_account, cogs_account, asset_account, expense_account. Accounts are NetSuite account ids (gl_accounts.netsuite_account_id).';
COMMENT ON COLUMN gl_netsuite_lists.active IS 'NetSuite''s own inactive flag, inverted. Independent of gone_at.';
COMMENT ON COLUMN gl_netsuite_lists.gone_at IS 'When a whole read of the list no longer had it. NULL = still in NetSuite.';
COMMENT ON COLUMN gl_netsuite_lists.changed_at IS 'When the copy last changed: added, or anything NetSuite holds for it changed.';
