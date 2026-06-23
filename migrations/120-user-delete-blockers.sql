-- Migration 120: user_delete_blockers(uuid)
--
-- Catalog-driven helper for /api/cni/delete-installer. Returns one row per
-- (table, column) that has a BLOCKING foreign key — NO ACTION or RESTRICT — to
-- profiles(id) or auth.users(id) and still references the target user.
--
-- The delete route uses it to (a) refuse a hard delete with a clear
-- "still referenced by X (n), deactivate instead" message instead of the
-- misleading "failed to delete auth user" FK error, and (b) avoid half-deleting
-- an account it can't fully remove (deleting the profile, then failing on the
-- auth user because some auth.users reference still blocks it).
--
-- CASCADE / SET NULL / SET DEFAULT references are intentionally excluded: those
-- resolve themselves when the user is deleted, so they never block. The
-- profiles.id -> auth.users self link is excluded for the same reason.

CREATE OR REPLACE FUNCTION public.user_delete_blockers(target uuid)
RETURNS TABLE(ref_table text, ref_column text, n bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r   record;
  cnt bigint;
BEGIN
  FOR r IN
    SELECT nsp.nspname AS sch, cl.relname AS tbl, att.attname AS col
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class      cl   ON cl.oid  = c.conrelid
    JOIN pg_catalog.pg_namespace  nsp  ON nsp.oid = cl.relnamespace
    JOIN pg_catalog.pg_class      fcl  ON fcl.oid = c.confrelid
    JOIN pg_catalog.pg_namespace  fnsp ON fnsp.oid = fcl.relnamespace
    JOIN pg_catalog.pg_attribute  att  ON att.attrelid = c.conrelid AND att.attnum = c.conkey[1]
    WHERE c.contype = 'f'
      AND c.confdeltype IN ('a', 'r')           -- NO ACTION / RESTRICT block; CASCADE/SET NULL/DEFAULT don't
      AND array_length(c.conkey, 1) = 1          -- single-column FKs (all the user FKs are)
      AND (
            (fnsp.nspname = 'public' AND fcl.relname = 'profiles') OR
            (fnsp.nspname = 'auth'   AND fcl.relname = 'users')
          )
      AND NOT (nsp.nspname = 'public' AND cl.relname = 'profiles' AND att.attname = 'id')  -- self link, cascades
  LOOP
    EXECUTE format('SELECT count(*) FROM %I.%I WHERE %I = $1', r.sch, r.tbl, r.col)
      INTO cnt USING target;
    IF cnt > 0 THEN
      ref_table  := r.sch || '.' || r.tbl;
      ref_column := r.col;
      n          := cnt;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

-- Only the service-role API route should call this; lock it down.
REVOKE ALL ON FUNCTION public.user_delete_blockers(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.user_delete_blockers(uuid) TO service_role';
  END IF;
END $$;
