-- Migration 476: FleetSuite's own books, part 43 — going live.
--
-- Owner decision 2026-10-10 (thread "Replacing NetSuite with FleetSuite"):
-- the books go live on January 1, 2027, opening at NetSuite's December 31
-- numbers (the NetSuite Exit Checklist's "Go-live switch",
-- src/lib/books/going-live.ts, docs/books.md "Going live"). The opening
-- entry is what still differs between FleetSuite's books and NetSuite's on
-- that day (src/lib/books/opening-balances.ts). On the receivable and
-- payable accounts it goes customer by customer and vendor by vendor, so
-- each one's balance opens at NetSuite's too:
--   * gl_opening_parties(company, through), each customer's and vendor's
--     balance on those accounts through a day, FleetSuite's journal next to
--     the copy of NetSuite's general ledger, where the two differ;
--   * gl_opening_entries(company), the opening entries a company's books
--     have: the first, and each that trued them up since.
--
-- The day a company's books start (gl_companies.books_live_from) is set by
-- the Going live page itself, once, and migration 359's triggers keep it:
-- it can't change, and nothing dated before it posts but opening balances.
--
-- Who a line belongs to is decided as on Customer and vendor balances
-- (migration 406). Both sides start from the same starting entry
-- (gl_netsuite_opening_parties), so it isn't read: what differs is what
-- each side moved since. NetSuite's lines count to the month NetSuite
-- posted them to, FleetSuite's to their date, as the trial balance counts
-- them (migrations 361 and 396).
--
-- Reader: the service role only, as the books are.

-- ── Each customer's and vendor's balance on the day ────────────────────────

-- One company's receivable and payable accounts through p_through, each
-- customer's or vendor's part on each, both sides, where they differ:
--   { parties: [{ account (NetSuite's id, or fs:<id>), kind ('customer' or
--                 'vendor'), party (a FleetSuite customer's id, a vendor's
--                 NetSuite id, '' for lines that name neither), name,
--                 netsuite, fleetsuite (what each side moved since the
--                 starting entry, debit positive) }] }
CREATE OR REPLACE FUNCTION public.gl_opening_parties(p_company TEXT, p_through DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  accounts AS (
    SELECT a.id, a.netsuite_account_id,
           CASE a.account_type WHEN 'accounts_receivable' THEN 'customer' ELSE 'vendor' END AS kind
    FROM public.gl_accounts a
    WHERE a.account_type IN ('accounts_receivable', 'accounts_payable')
      AND (a.company_id IS NULL OR a.company_id = (SELECT id FROM company))
  ),
  -- NetSuite's customers the ledger mirror matched to a FleetSuite customer by their NetSuite ids.
  matched AS (
    SELECT substr(lc.external_id, 10) AS entity_id, lc.customer_id
    FROM public.ledger_customers lc
    WHERE lc.source = 'netsuite' AND lc.external_id LIKE 'customer/%'
      AND lc.match_status = 'exact' AND lc.customer_id IS NOT NULL
  ),
  ns AS (
    SELECT a.id AS account_id, a.kind,
           CASE WHEN a.kind = 'vendor' THEN coalesce(l.entity_id, '') ELSE coalesce(m.customer_id::text, '') END AS party,
           sum(l.debit - l.credit) AS net
    FROM public.gl_netsuite_lines l
    JOIN accounts a ON a.netsuite_account_id = l.netsuite_account_id
    LEFT JOIN matched m ON a.kind = 'customer' AND m.entity_id = l.entity_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.posting_month <= date_trunc('month', p_through)::date
    GROUP BY 1, 2, 3
  ),
  fs AS (
    SELECT a.id AS account_id, a.kind,
           CASE WHEN a.kind = 'vendor' THEN coalesce(l.vendor_ref, '') ELSE coalesce(l.customer_id::text, '') END AS party,
           sum(l.debit - l.credit) AS net
    FROM public.gl_lines l
    JOIN accounts a ON a.id = l.account_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.entry_date <= p_through
    GROUP BY 1, 2, 3
  ),
  sides AS (
    SELECT coalesce(n.account_id, f.account_id) AS account_id,
           coalesce(n.kind, f.kind) AS kind,
           coalesce(n.party, f.party) AS party,
           coalesce(n.net, 0) AS netsuite,
           coalesce(f.net, 0) AS fleetsuite
    FROM ns n
    FULL JOIN fs f ON f.account_id = n.account_id AND f.party = n.party
  )
  SELECT jsonb_build_object('parties', coalesce(jsonb_agg(jsonb_build_object(
    'account', coalesce(a.netsuite_account_id, 'fs:' || a.id::text),
    'kind', s.kind,
    'party', s.party,
    'name', CASE
      WHEN s.party = '' THEN NULL
      WHEN s.kind = 'vendor' THEN (
        SELECT coalesce(v.name, lc.display_name)
        FROM (SELECT s.party AS entity_id) x
        LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.entity_id
        LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || x.entity_id
      )
      ELSE coalesce(
        (SELECT nullif(btrim(c.company_name), '') FROM public.customers c WHERE c.id = s.party::uuid),
        (SELECT lc.display_name FROM public.ledger_customers lc
         WHERE lc.source = 'netsuite' AND lc.match_status = 'exact' AND lc.customer_id = s.party::uuid
         ORDER BY lc.external_id LIMIT 1)
      )
    END,
    'netsuite', s.netsuite::text,
    'fleetsuite', s.fleetsuite::text
  ) ORDER BY a.number NULLS LAST, a.id, s.party), '[]'::jsonb))
  FROM sides s
  JOIN public.gl_accounts a ON a.id = s.account_id
  WHERE s.netsuite <> s.fleetsuite
$$;

-- ── The opening entries posted ─────────────────────────────────────────────

-- One company's opening entries, oldest first:
--   { entries: [{ id, entry_no, entry_date, memo, posted_at, posted_by_name,
--                 debit (what it posts in all), lines, reversed_by (the
--                 entry_no of its reversal, or null) }] }
CREATE OR REPLACE FUNCTION public.gl_opening_entries(p_company TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT jsonb_build_object('entries', coalesce(jsonb_agg(jsonb_build_object(
    'id', e.id,
    'entry_no', e.entry_no,
    'entry_date', to_char(e.entry_date, 'YYYY-MM-DD'),
    'memo', e.memo,
    'posted_at', e.posted_at,
    'posted_by_name', e.posted_by_name,
    'debit', (SELECT coalesce(sum(l.debit), 0)::text FROM public.gl_lines l WHERE l.entry_id = e.id),
    'lines', (SELECT count(*) FROM public.gl_lines l WHERE l.entry_id = e.id),
    'reversed_by', (SELECT r.entry_no FROM public.gl_entries r WHERE r.reverses_entry_id = e.id)
  ) ORDER BY e.entry_no), '[]'::jsonb))
  FROM public.gl_entries e
  WHERE e.company_id = (SELECT id FROM public.gl_companies WHERE code = p_company)
    AND e.source_type = 'opening_balance'
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.gl_opening_parties(text, date)', 'public.gl_opening_entries(text)'] LOOP
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

COMMENT ON FUNCTION public.gl_opening_parties(text, date) IS 'Migration 476: each customer''s and vendor''s balance on one company''s receivable and payable accounts through a day, FleetSuite''s journal next to the copy of NetSuite''s GL, where they differ, which the opening entry posts customer by customer and vendor by vendor when the books go live. Service role only.';
COMMENT ON FUNCTION public.gl_opening_entries(text) IS 'Migration 476: one company''s opening entries (source_type opening_balance), oldest first, with what each posts in all and its reversal if any, for the Going live page and the posting run that posts them. Service role only.';
