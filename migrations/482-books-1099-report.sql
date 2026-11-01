-- Migration 482: FleetSuite's own books, part 51 — NetSuite's 1099 report
-- next to FleetSuite's totals.
--
-- The NetSuite Exit Checklist (thread "Replacing NetSuite with FleetSuite",
-- 2026-10-31; built without asking under the owner's go of 02:05Z): the
-- 1099 dry run checks the totals per vendor FleetSuite works out from its
-- copy of NetSuite (part 50, migration 481) against NetSuite's 1099s. A
-- super admin exports NetSuite's 1099 report and uploads it on Books →
-- 1099s; the page reads it on the device it's picked on
-- (src/lib/books/1099-report.ts) and sends only each vendor's names and
-- amounts by box, kept here for the company's year:
--
--   gl_netsuite_1099_reports: one report per company and year, a new one
--     replacing the one before. Each vendor as the report names it, its
--     other names (a legal name, say) and its amounts in whole cents by
--     column, with the columns' headings and the box each is for, the
--     headings of the columns left out, and the lines of the report's
--     title. The comparison is worked out each time the page opens, so it
--     follows FleetSuite's copies as they're brought up to date.
--
-- A vendor's tax ID is never kept: the page leaves out any column that
-- holds one and takes out any run of nine digits in what it sends, the
-- route refuses one, and so does this table (gl_1099_report_has_nine_digits).
-- Nothing is sent to NetSuite or filed.
--
-- Writer and reader: the service role only. RLS is on with no policies, and
-- anon/authenticated have no table or function privileges.

-- Whether any text in p, at any depth, has a run of nine digits or more one
-- character apart at most ("123-45-6789", "12 3456789"): a tax ID, maybe.
-- Amounts are numbers, not text, so they're not looked at. The same rule as
-- src/lib/books/1099-report.ts.
CREATE OR REPLACE FUNCTION public.gl_1099_report_has_nine_digits(p JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_path_query(p, 'strict $.**') AS t(v)
    WHERE jsonb_typeof(t.v) = 'string' AND (t.v #>> '{}') ~ '[0-9]([^0-9A-Za-z]?[0-9]){8,}'
  )
$$;

CREATE TABLE IF NOT EXISTS gl_netsuite_1099_reports (
  company_id UUID NOT NULL REFERENCES gl_companies(id),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  file_name TEXT NOT NULL CHECK (btrim(file_name) <> '' AND length(file_name) <= 200),
  title_lines JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(title_lines) = 'array'),
  amount_columns JSONB NOT NULL CHECK (jsonb_typeof(amount_columns) = 'array' AND jsonb_array_length(amount_columns) BETWEEN 1 AND 40),
  left_out JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(left_out) = 'array'),
  vendors JSONB NOT NULL CHECK (jsonb_typeof(vendors) = 'array' AND jsonb_array_length(vendors) BETWEEN 1 AND 5000),
  skipped JSONB NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(skipped) = 'object'),
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, year),
  CONSTRAINT gl_netsuite_1099_reports_no_tax_ids CHECK (NOT public.gl_1099_report_has_nine_digits(
    jsonb_build_array(file_name, title_lines, amount_columns, left_out, vendors)
  ))
);

-- Keeps NetSuite's 1099 report for one company's year, replacing the one
-- before. p:
--   { company, year, file_name, title: [text], left_out: [text],
--     columns: [{ key: 'c1', header, box (null for the total) }],
--     vendors: [{ label, names: [text], amounts: { c1: cents } }],
--     skipped: { totals, no_name, combined }, uploaded_by }
-- Refused whole when anything is the wrong shape, an amount isn't whole
-- cents under a listed column, or any text has nine digits in a row.
-- Returns { company, year, vendors, replaced }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_1099_report_save(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
  v_year INTEGER;
  v_bad TEXT;
  v_columns JSONB;
  v_vendors JSONB;
  v_replaced BOOLEAN;
BEGIN
  SELECT c.id INTO v_company FROM public.gl_companies c WHERE c.code = p->>'company';
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: no company %', coalesce(p->>'company', '(none)');
  END IF;
  IF coalesce(p->>'year', '') !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'gl: the year must be four digits';
  END IF;
  v_year := (p->>'year')::integer;
  IF btrim(coalesce(p->>'file_name', '')) = '' THEN
    RAISE EXCEPTION 'gl: the report''s file name is missing';
  END IF;
  IF jsonb_typeof(coalesce(p->'title', '[]')) IS DISTINCT FROM 'array'
     OR jsonb_typeof(coalesce(p->'left_out', '[]')) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(p->'title', '[]') || coalesce(p->'left_out', '[]')) AS x(v)
                WHERE jsonb_typeof(x.v) <> 'string') THEN
    RAISE EXCEPTION 'gl: the report''s title and left-out headings must be lists of text';
  END IF;

  IF jsonb_typeof(p->'columns') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'columns') = 0 THEN
    RAISE EXCEPTION 'gl: the report needs a column of amounts';
  END IF;
  SELECT coalesce(x.v->>'key', '(none)') INTO v_bad
  FROM jsonb_array_elements(p->'columns') AS x(v)
  WHERE coalesce(x.v->>'key', '') !~ '^c[0-9]{1,2}$'
     OR jsonb_typeof(x.v->'header') IS DISTINCT FROM 'string' OR btrim(x.v->>'header') = ''
     OR NOT (x.v ? 'box') OR jsonb_typeof(x.v->'box') NOT IN ('string', 'null') OR btrim(coalesce(x.v->>'box', 'total')) = ''
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: column % needs a key, a heading and a box or none', v_bad;
  END IF;
  SELECT x.v->>'key' INTO v_bad
  FROM jsonb_array_elements(p->'columns') AS x(v)
  GROUP BY x.v->>'key' HAVING count(*) > 1
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: column % is in the report twice', v_bad;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('key', x.v->>'key', 'header', btrim(x.v->>'header'), 'box', btrim(x.v->>'box')) ORDER BY x.n)
  INTO v_columns
  FROM jsonb_array_elements(p->'columns') WITH ORDINALITY AS x(v, n);

  IF jsonb_typeof(p->'vendors') IS DISTINCT FROM 'array' OR jsonb_array_length(p->'vendors') = 0 THEN
    RAISE EXCEPTION 'gl: the report lists no vendors';
  END IF;
  SELECT x.n::text INTO v_bad
  FROM jsonb_array_elements(p->'vendors') WITH ORDINALITY AS x(v, n)
  WHERE jsonb_typeof(x.v->'label') IS DISTINCT FROM 'string' OR btrim(x.v->>'label') = ''
     OR jsonb_typeof(coalesce(x.v->'names', '[]')) IS DISTINCT FROM 'array'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(x.v->'names', '[]')) AS m(v) WHERE jsonb_typeof(m.v) <> 'string')
     OR jsonb_typeof(x.v->'amounts') IS DISTINCT FROM 'object'
     OR EXISTS (
       SELECT 1 FROM jsonb_each(x.v->'amounts') AS a(k, c)
       WHERE jsonb_typeof(a.c) <> 'number' OR (a.c #>> '{}') !~ '^-?[0-9]{1,14}$'
          OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_columns) AS k(v) WHERE k.v->>'key' = a.k)
     )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'gl: vendor % of the report needs a name and its amounts in whole cents under the report''s columns', v_bad;
  END IF;
  SELECT jsonb_agg(jsonb_build_object(
    'label', btrim(x.v->>'label'),
    'names', coalesce(x.v->'names', '[]'),
    'amounts', x.v->'amounts'
  ) ORDER BY x.n)
  INTO v_vendors
  FROM jsonb_array_elements(p->'vendors') WITH ORDINALITY AS x(v, n);

  IF public.gl_1099_report_has_nine_digits(jsonb_build_array(p->'file_name', p->'title', v_columns, p->'left_out', v_vendors)) THEN
    RAISE EXCEPTION 'gl: the report has nine digits in a row in a name or heading, which could be a tax ID, so it isn''t kept';
  END IF;

  INSERT INTO public.gl_netsuite_1099_reports AS r
    (company_id, year, file_name, title_lines, amount_columns, left_out, vendors, skipped, uploaded_by, uploaded_at)
  VALUES (
    v_company, v_year, btrim(p->>'file_name'), coalesce(p->'title', '[]'), v_columns, coalesce(p->'left_out', '[]'), v_vendors,
    jsonb_build_object(
      'totals', coalesce((p->'skipped'->>'totals')::integer, 0),
      'no_name', coalesce((p->'skipped'->>'no_name')::integer, 0),
      'combined', coalesce((p->'skipped'->>'combined')::integer, 0)
    ),
    nullif(p->>'uploaded_by', '')::uuid, now()
  )
  ON CONFLICT (company_id, year) DO UPDATE SET
    file_name = EXCLUDED.file_name,
    title_lines = EXCLUDED.title_lines,
    amount_columns = EXCLUDED.amount_columns,
    left_out = EXCLUDED.left_out,
    vendors = EXCLUDED.vendors,
    skipped = EXCLUDED.skipped,
    uploaded_by = EXCLUDED.uploaded_by,
    uploaded_at = EXCLUDED.uploaded_at
  RETURNING (xmax <> 0) INTO v_replaced;

  RETURN jsonb_build_object('company', p->>'company', 'year', v_year, 'vendors', jsonb_array_length(v_vendors), 'replaced', v_replaced);
END;
$$;

-- Takes NetSuite's 1099 report for one company's year off. Returns { removed }.
CREATE OR REPLACE FUNCTION public.gl_netsuite_1099_report_remove(p_company TEXT, p_year INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_company UUID;
  v_removed INTEGER;
BEGIN
  SELECT c.id INTO v_company FROM public.gl_companies c WHERE c.code = p_company;
  IF v_company IS NULL THEN
    RAISE EXCEPTION 'gl: no company %', coalesce(p_company, '(none)');
  END IF;
  DELETE FROM public.gl_netsuite_1099_reports r WHERE r.company_id = v_company AND r.year = p_year;
  GET DIAGNOSTICS v_removed = ROW_COUNT;
  RETURN jsonb_build_object('removed', v_removed > 0);
END;
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE gl_netsuite_1099_reports ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE gl_netsuite_1099_reports FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.gl_1099_report_has_nine_digits(jsonb)',
    'public.gl_netsuite_1099_report_save(jsonb)',
    'public.gl_netsuite_1099_report_remove(text, integer)'
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

COMMENT ON TABLE gl_netsuite_1099_reports IS 'Migration 482: NetSuite''s 1099 report for a company''s year, uploaded on Books → 1099s to hold against FleetSuite''s totals: each vendor''s names and amounts by box only, never a tax ID. A new upload replaces the one before. Service-role write and read.';
COMMENT ON COLUMN gl_netsuite_1099_reports.amount_columns IS 'The report''s columns of amounts kept: [{ key, header, box }], box null for the total.';
COMMENT ON COLUMN gl_netsuite_1099_reports.vendors IS 'Each vendor as the report names it: [{ label, names, amounts: { key: cents } }].';
COMMENT ON COLUMN gl_netsuite_1099_reports.left_out IS 'The headings of the report''s columns not kept: tax IDs, addresses and anything else that isn''t a name or an amount for a box.';
COMMENT ON FUNCTION public.gl_1099_report_has_nine_digits(jsonb) IS 'Migration 482: whether any text in it has nine digits in a row, a tax ID maybe. Keeps tax IDs out of gl_netsuite_1099_reports.';
COMMENT ON FUNCTION public.gl_netsuite_1099_report_save(jsonb) IS 'Migration 482: keeps NetSuite''s 1099 report for a company''s year, replacing the one before; refuses anything with nine digits in a row. Service role only.';
COMMENT ON FUNCTION public.gl_netsuite_1099_report_remove(text, integer) IS 'Migration 482: takes NetSuite''s 1099 report for a company''s year off. Service role only.';
