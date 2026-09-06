-- Migration 254: CRM lifecycle hardening (Round 3, R3-9 / §7.2.5)
--
-- Two pieces:
--
-- 1) prospects.promote_claimed_at — the atomic claim for promotion.
--    promoteProspect() was a read-then-act race: two concurrent promotions
--    of the same lead (a double-clicked "Promote" button, or an estimate
--    push racing the button) both passed the stale netsuite_id check and
--    minted TWO NetSuite customers. Same claim discipline as the
--    conversion claim (migration 245) and the invoice claims (251):
--    claim → create → stamp retires the claim; release on failure; a
--    stale claim (15 min) is reclaimable.
--
-- 2) A deny trigger on the identity columns. The linkage between a CRM
--    record and its NetSuite customer (netsuite_id and friends) decides
--    which real NetSuite record a later DELETE destroys and where money
--    documents attach. Browser-side staff RLS allowed any staff login to
--    re-point it silently. These columns are now written only by
--    service-role code (the promote paths, the syncs, PUT /api/prospects —
--    which requires an admin and audit-logs the change). Deliberately NO
--    admin exemption here, unlike 233: "admin-only AND audited" means the
--    audited route is the only path, a browser console included.
--
--    Columns are compared through to_jsonb(OLD)/to_jsonb(NEW) (the 233
--    pattern) so a guarded column absent from a drifted database is simply
--    absent from the map instead of raising at runtime.

ALTER TABLE prospects ADD COLUMN IF NOT EXISTS promote_claimed_at TIMESTAMPTZ;
COMMENT ON COLUMN prospects.promote_claimed_at IS
  'Atomic promotion claim (migration 254): stamped before the NetSuite customer create, retired by the netsuite_id stamp, released on failure. A claim older than 15 minutes is stale and reclaimable.';

CREATE OR REPLACE FUNCTION public.guard_prospect_identity_columns()
RETURNS TRIGGER AS $$
DECLARE
  guarded_cols text[] := ARRAY[
    'netsuite_id', 'netsuite_url', 'netsuite_type',
    'converted_customer_id', 'pushed_at', 'pushed_by',
    'promote_claimed_at'
  ];
  col text;
  old_row jsonb;
  new_row jsonb := to_jsonb(NEW);
BEGIN
  -- Service role / SECURITY DEFINER contexts carry no end-user identity;
  -- every legitimate writer (promote paths, syncs, the prospects API) runs
  -- there. Service role bypasses RLS but NOT triggers, so this exemption is
  -- what keeps those paths working.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    old_row := to_jsonb(OLD);
    FOREACH col IN ARRAY guarded_cols LOOP
      IF (new_row ? col) AND (old_row -> col) IS DISTINCT FROM (new_row -> col) THEN
        RAISE EXCEPTION
          'permission denied: prospects.% is written only by the promote/link routes', col
          USING ERRCODE = '42501';
      END IF;
    END LOOP;
    RETURN NEW;
  END IF;

  -- INSERT: a browser-created record starts unlinked. (The one legitimate
  -- linked create — "Add Record" for an existing NetSuite customer — runs
  -- through POST /api/prospects, service-role, which copies the identity
  -- from the customers mirror rather than trusting the client.)
  FOREACH col IN ARRAY guarded_cols LOOP
    IF (new_row ? col) AND jsonb_typeof(new_row -> col) <> 'null' THEN
      RAISE EXCEPTION
        'permission denied: prospects.% is not client-assignable', col
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = '';

DROP TRIGGER IF EXISTS trg_guard_prospect_identity_columns ON public.prospects;
CREATE TRIGGER trg_guard_prospect_identity_columns
  BEFORE INSERT OR UPDATE ON public.prospects
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_prospect_identity_columns();

COMMENT ON FUNCTION public.guard_prospect_identity_columns() IS
  'Migration 254: the NetSuite linkage columns on prospects (netsuite_id, netsuite_url, netsuite_type, converted_customer_id, pushed_at, pushed_by, promote_claimed_at) are written only by service-role code — the promote paths, the syncs, and PUT /api/prospects (admin + audit). Signed-in clients cannot set or change them.';
