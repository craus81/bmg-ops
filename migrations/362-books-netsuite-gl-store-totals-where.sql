-- Migration 362: the NetSuite GL copy's totals can be stored through the API.
--
-- gl_netsuite_store_totals (migration 361) emptied its two tables with a
-- bare DELETE before inserting NetSuite's new totals. Supabase's API
-- connections load the safeupdate extension, which refuses any DELETE or
-- UPDATE without a WHERE clause, even inside a function, so the first copy
-- in production stopped with "DELETE requires a WHERE clause". The same
-- function, with WHERE true on both deletes.

CREATE OR REPLACE FUNCTION public.gl_netsuite_store_totals(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_opening INTEGER;
  v_months INTEGER;
BEGIN
  IF jsonb_typeof(p->'opening') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'months') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'gl: opening and months must be lists';
  END IF;
  IF jsonb_array_length(p->'opening') = 0 AND jsonb_array_length(p->'months') = 0
     AND (EXISTS (SELECT 1 FROM public.gl_netsuite_opening) OR EXISTS (SELECT 1 FROM public.gl_netsuite_month_totals)) THEN
    RAISE EXCEPTION 'gl: NetSuite''s totals came back empty, so the stored ones were kept';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'opening') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p->'months') AS x(company TEXT)
    LEFT JOIN public.gl_companies c ON c.code = x.company WHERE c.id IS NULL
  ) THEN
    RAISE EXCEPTION 'gl: NetSuite totals name a company that doesn''t exist';
  END IF;

  -- WHERE true: safeupdate refuses a DELETE without a WHERE clause.
  DELETE FROM public.gl_netsuite_opening WHERE true;
  DELETE FROM public.gl_netsuite_month_totals WHERE true;

  INSERT INTO public.gl_netsuite_opening (company_id, netsuite_account_id, debit, credit, line_count)
  SELECT c.id, x.netsuite_account_id, x.debit, x.credit, x.line_count
  FROM jsonb_to_recordset(p->'opening') AS x(company TEXT, netsuite_account_id TEXT, debit NUMERIC, credit NUMERIC, line_count INTEGER)
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_opening = ROW_COUNT;

  INSERT INTO public.gl_netsuite_month_totals (company_id, netsuite_account_id, month, debit, credit, line_count)
  SELECT c.id, x.netsuite_account_id, x.month, x.debit, x.credit, x.line_count
  FROM jsonb_to_recordset(p->'months') AS x(company TEXT, netsuite_account_id TEXT, month DATE, debit NUMERIC, credit NUMERIC, line_count INTEGER)
  JOIN public.gl_companies c ON c.code = x.company;
  GET DIAGNOSTICS v_months = ROW_COUNT;

  RETURN jsonb_build_object('opening', v_opening, 'months', v_months);
END;
$$;

-- Same access as migration 361 gave it: the service role only.
DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_netsuite_store_totals(jsonb) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_netsuite_store_totals(jsonb) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_netsuite_store_totals(jsonb) TO service_role;
  END IF;
END $$;
