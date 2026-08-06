-- Migration 182: Repair exec_readonly_sql (broken by migration 045)
--
-- The AI agent's Supabase queries all go through exec_readonly_sql (RPC from
-- src/app/api/ai-agent/chat/route.ts, called with the service-role key).
-- Migration 045's rewrite of the function broke it three ways:
--
--   1. SET search_path = '' — every unqualified table reference
--      ("FROM purchase_orders") now fails with `relation does not exist`,
--      which the AI agent misreports as a permissions gap on the table.
--   2. `EXECUTE query INTO result` — only works for a single-row,
--      single-column result; any real SELECT (multiple columns/rows)
--      errors out instead of returning rows.
--   3. It dropped the SELECT-only guard while keeping SECURITY DEFINER and
--      the default PUBLIC execute grant, so any client holding the anon or
--      authenticated key could run arbitrary statements (e.g.
--      `INSERT ... RETURNING to_json(...)`) with definer privileges.
--
-- This restores the original 015 behavior (wrap the query in json_agg and
-- return all rows), pins search_path to a fixed value that still resolves
-- unqualified public tables (a fixed non-empty path satisfies the
-- function_search_path_mutable linter), re-adds the write guard using word
-- boundaries so column names like created_at no longer false-positive, and
-- locks execution down to service_role.

CREATE OR REPLACE FUNCTION public.exec_readonly_sql(query TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result JSON;
  normalized TEXT;
BEGIN
  normalized := UPPER(TRIM(query));

  IF NOT (normalized LIKE 'SELECT%' OR normalized LIKE 'WITH%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Defense in depth against data-modifying CTEs and injection: block
  -- write/DDL keywords as standalone words only, so identifiers such as
  -- created_at, updated_by, or last_update pass through.
  IF normalized ~ '\m(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\M' THEN
    RAISE EXCEPTION 'Write operations are not allowed';
  END IF;

  EXECUTE 'SELECT json_agg(row_to_json(t)) FROM (' || query || ') t' INTO result;

  IF result IS NULL THEN
    result := '[]'::json;
  END IF;

  RETURN result;
END;
$$;

-- SECURITY DEFINER + unrestricted reads: only the server-side service role
-- (used by the AI agent API route) may execute this function.
REVOKE ALL ON FUNCTION public.exec_readonly_sql(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.exec_readonly_sql(TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.exec_readonly_sql(TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.exec_readonly_sql(TEXT) TO service_role;
