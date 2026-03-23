-- Migration 015: Create a read-only SQL execution function for the AI agent
-- This function allows the AI agent to run SELECT queries against the database
-- It is restricted to SELECT/WITH statements only for safety

CREATE OR REPLACE FUNCTION exec_readonly_sql(query text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result json;
  normalized text;
BEGIN
  -- Normalize and check it's a SELECT
  normalized := UPPER(TRIM(query));
  IF NOT (normalized LIKE 'SELECT%' OR normalized LIKE 'WITH%') THEN
    RAISE EXCEPTION 'Only SELECT queries are allowed';
  END IF;

  -- Block dangerous keywords even in subqueries
  IF normalized LIKE '%INSERT%INTO%' OR
     normalized LIKE '%UPDATE%SET%' OR
     normalized LIKE '%DELETE%FROM%' OR
     normalized LIKE '%DROP%' OR
     normalized LIKE '%ALTER%' OR
     normalized LIKE '%TRUNCATE%' OR
     normalized LIKE '%CREATE%' OR
     normalized LIKE '%GRANT%' OR
     normalized LIKE '%REVOKE%' THEN
    RAISE EXCEPTION 'Write operations are not allowed';
  END IF;

  EXECUTE 'SELECT json_agg(row_to_json(t)) FROM (' || query || ') t' INTO result;

  -- Return empty array instead of null
  IF result IS NULL THEN
    result := '[]'::json;
  END IF;

  RETURN result;
END;
$$;
