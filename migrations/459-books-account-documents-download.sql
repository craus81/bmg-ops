-- Migration 459: FleetSuite's own books, part 33 — Excel downloads.
--
-- The NetSuite Exit Checklist's "Excel downloads" (thread "Replacing
-- NetSuite with FleetSuite", owner's go-ahead 2026-10-31): Reports and an
-- account line's detail download as Excel (src/lib/books/report-workbook.ts,
-- docs/books.md "Excel downloads"), the detail as every document that moved
-- the account with each side's running balance. A year of a busy account
-- (sales, inventory, a bank account) can hold more than the 2,000 documents
-- gl_books_account_documents (migration 400) gives at once, and a running
-- balance needs all of them, so this is the same function taking up to
-- 20,000. The detail page still asks for 1,000. A read-only function,
-- service role only, no table changes.

-- One company's documents on one account in the months from p_from through
-- p_to, both sides, as Reports and Differences vs NetSuite count them:
-- NetSuite's in the month it posted to (its accounting period), FleetSuite's
-- by each entry's date, a reversal with the document it reverses. The
-- account is named as gl_books_totals (migration 396) names it: its NetSuite
-- id, or 'fs:<id>' for one NetSuite doesn't have. A document is the same on
-- both sides when FleetSuite's source_id is NetSuite's internal id; any other
-- FleetSuite entry (a typed entry, an opening balance) is a document of its
-- own, 'entry:<id>' of the entry it is or reverses. A document whose lines
-- on the account come to nothing on both sides is left out.
--
-- With p_differs, only the documents whose two sides differ. Returns how many
-- documents there are and how many differ, what each side's come to (debit
-- positive), and at most p_limit of them (1 to 20000), by date (NetSuite's,
-- else FleetSuite's newest entry's), with:
--   netsuite, fleetsuite  what each side moved on the account (decimal
--                         strings, debit positive);
--   kind                  FleetSuite's source type for it, when it has one;
--   type, number, month   NetSuite's transaction type, number and the month
--                         it posted to, from the copy (null for a document
--                         NetSuite doesn't have);
--   name                  the copy of NetSuite's vendors' name for the line's
--                         name, else the ledger mirror's for a customer, as
--                         gl_journal_month (migration 393) names them;
--   memo                  NetSuite's first memo on the account, else
--                         FleetSuite's;
--   entry_no, entries     FleetSuite's newest entry for it on the account and
--                         how many it has had there.
CREATE OR REPLACE FUNCTION public.gl_books_account_documents(
  p_company TEXT, p_account TEXT, p_from DATE, p_to DATE, p_differs BOOLEAN, p_limit INTEGER
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH company AS (
    SELECT id FROM public.gl_companies WHERE code = p_company
  ),
  span AS (
    SELECT date_trunc('month', p_from)::date AS first_month,
           date_trunc('month', p_to)::date AS last_month,
           (date_trunc('month', p_to) + interval '1 month')::date AS after
  ),
  accounts AS (
    SELECT a.id FROM public.gl_accounts a WHERE coalesce(a.netsuite_account_id, 'fs:' || a.id::text) = p_account
  ),
  ns AS (
    SELECT l.transaction_id AS doc,
           sum(l.debit) - sum(l.credit) AS net,
           (array_agg(l.entity_id ORDER BY l.line_id::bigint) FILTER (WHERE l.entity_id IS NOT NULL))[1] AS entity_id,
           (array_agg(btrim(l.memo) ORDER BY l.line_id::bigint) FILTER (WHERE btrim(l.memo) <> ''))[1] AS memo
    FROM public.gl_netsuite_lines l
    WHERE l.company_id = (SELECT id FROM company)
      AND l.netsuite_account_id = p_account
      AND l.posting_month >= (SELECT first_month FROM span)
      AND l.posting_month <= (SELECT last_month FROM span)
    GROUP BY l.transaction_id
  ),
  fs_lines AS (
    SELECT CASE WHEN coalesce(o.source_id, e.source_id) ~ '^[0-9]+$' THEN coalesce(o.source_id, e.source_id)
                ELSE 'entry:' || coalesce(o.id, e.id)::text END AS doc,
           coalesce(o.source_type, e.source_type) AS kind,
           e.id AS entry_id,
           e.entry_no,
           e.entry_date,
           coalesce(nullif(btrim(l.memo), ''), nullif(btrim(coalesce(o.memo, e.memo)), '')) AS memo,
           l.line_no,
           l.debit,
           l.credit
    FROM public.gl_lines l
    JOIN public.gl_entries e ON e.id = l.entry_id
    LEFT JOIN public.gl_entries o ON o.id = e.reverses_entry_id
    WHERE l.company_id = (SELECT id FROM company)
      AND l.account_id IN (SELECT id FROM accounts)
      AND l.entry_date >= (SELECT first_month FROM span)
      AND l.entry_date < (SELECT after FROM span)
  ),
  fs AS (
    SELECT doc,
           -- An invoice's cost lines are FleetSuite's own kind of the same document; they post to other accounts.
           min(kind) AS kind,
           sum(debit) - sum(credit) AS net,
           count(DISTINCT entry_id) AS entries,
           max(entry_no) AS entry_no,
           (array_agg(entry_date ORDER BY entry_no DESC))[1] AS entry_date,
           (array_agg(memo ORDER BY entry_no, line_no) FILTER (WHERE memo IS NOT NULL))[1] AS memo
    FROM fs_lines
    GROUP BY doc
  ),
  moving AS (
    SELECT coalesce(n.doc, f.doc) AS doc,
           coalesce(n.net, 0) AS netsuite,
           coalesce(f.net, 0) AS fleetsuite,
           f.kind,
           f.entries,
           f.entry_no,
           n.entity_id,
           coalesce(n.memo, f.memo) AS memo,
           t.tran_type,
           t.tranid,
           t.posting_month,
           coalesce(t.trandate, f.entry_date) AS doc_date
    FROM ns n
    FULL JOIN fs f ON f.doc = n.doc
    LEFT JOIN public.gl_netsuite_transactions t ON t.netsuite_id = coalesce(n.doc, f.doc)
    WHERE coalesce(n.net, 0) <> 0 OR coalesce(f.net, 0) <> 0
  ),
  picked AS (
    SELECT *
    FROM moving
    WHERE NOT coalesce(p_differs, false) OR fleetsuite <> netsuite
    ORDER BY doc_date, tranid, doc
    LIMIT greatest(1, least(coalesce(p_limit, 1000), 20000))
  )
  SELECT jsonb_build_object(
    'documents', (SELECT count(*) FROM moving),
    'differing', (SELECT count(*) FROM moving WHERE fleetsuite <> netsuite),
    'netsuite', (SELECT coalesce(sum(netsuite), 0)::text FROM moving),
    'fleetsuite', (SELECT coalesce(sum(fleetsuite), 0)::text FROM moving),
    'rows', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'doc', p.doc,
        'netsuite', p.netsuite::text,
        'fleetsuite', p.fleetsuite::text,
        'kind', p.kind,
        'type', p.tran_type,
        'number', p.tranid,
        'month', to_char(p.posting_month, 'YYYY-MM-DD'),
        'date', to_char(p.doc_date, 'YYYY-MM-DD'),
        'name', (
          -- The account's own line's name, else the document's first.
          SELECT coalesce(v.name, lc.display_name)
          FROM (
            SELECT coalesce(p.entity_id, (
              SELECT l.entity_id FROM public.gl_netsuite_lines l
              WHERE l.transaction_id = p.doc AND l.company_id = (SELECT id FROM company) AND l.entity_id IS NOT NULL
              ORDER BY l.line_id::bigint
              LIMIT 1
            )) AS entity_id
          ) x
          LEFT JOIN public.gl_netsuite_lists v ON v.kind = 'vendor' AND v.netsuite_id = x.entity_id
          LEFT JOIN public.ledger_customers lc ON lc.source = 'netsuite' AND lc.external_id = 'customer/' || x.entity_id
        ),
        'memo', p.memo,
        'entry_no', p.entry_no,
        'entries', coalesce(p.entries, 0)
      ) ORDER BY p.doc_date, p.tranid, p.doc), '[]'::jsonb)
      FROM picked p
    )
  )
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT := 'public.gl_books_account_documents(text, text, date, date, boolean, integer)';
  r TEXT;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', f, r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_books_account_documents(text, text, date, date, boolean, integer) IS 'Migrations 400 and 459: the documents that moved one of a company''s accounts (its NetSuite id, or fs:<id>) in a range of months, FleetSuite''s journal by entry date next to the copy of NetSuite''s GL by posting month, document by document, with their numbers, names and memos, for the report detail page (up to 1,000) and its Excel download (up to 20,000). Service role only.';
