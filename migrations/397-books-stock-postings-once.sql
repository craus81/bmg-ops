-- Migration 397: FleetSuite's own books — the stock postings read the copy's
-- cost lines once.
--
-- Field bug 2026-10-17 (thread "Replacing NetSuite with FleetSuite"): once
-- the posting job had posted the cost lines of NetSuite's invoices and
-- credit memos (migration 395), every run stopped at its first read with
-- "canceling statement due to statement timeout", Post now's too, so nothing
-- new posted. gl_stock_postings asked, for each invoice or credit memo with
-- a cost entry, whether the copy of NetSuite's GL still has a cost line of
-- it, by reading the copy's cost lines (gl_netsuite_cost_lines) a month at a
-- time until a month had it: for thousands of documents, each up to one
-- read of the whole copy per month, in the one statement that starts every
-- run.
--
-- This replaces gl_stock_postings with what it returns unchanged: the
-- invoices and credit memos the copy has a cost line of for the company are
-- read once, from every month, and only when the journal holds a cost
-- entry; each document is then looked up in them. A transaction's lines
-- share its month in the copy (migration 361), so reading every month finds
-- what reading the document's own month did. No table is added or changed.
--
-- Caller: the service role only, from the posting job and the super admin
-- pages' APIs.

-- What one company's journal holds for its NetSuite stock documents, as
-- migration 395 gives it: every one with an entry (or only those in
-- p_source_ids, NetSuite's ids), each with source_type, entries, unreversed,
-- current, history and document (its number, and deleted, when the copy
-- holds no line of it for the company, for an invoice or credit memo no cost
-- line).
CREATE OR REPLACE FUNCTION public.gl_stock_postings(p_company TEXT, p_source_ids TEXT[], p_lines BOOLEAN)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH entries AS (
    SELECT e.id, e.company_id, e.entry_no, e.entry_date, e.source_type, e.source_id, e.memo, r.entry_no AS reversed_by
    FROM public.gl_entries e
    JOIN public.gl_companies c ON c.id = e.company_id
    LEFT JOIN public.gl_entries r ON r.reverses_entry_id = e.id
    WHERE c.code = p_company
      AND e.source_type IN (
        'item_fulfillment', 'item_receipt', 'inventory_adjustment', 'inventory_transfer', 'assembly_build', 'assembly_unbuild',
        'invoice_cost'
      )
      AND e.source_id IS NOT NULL
      AND (p_source_ids IS NULL OR e.source_id = ANY (p_source_ids))
  ),
  docs AS (
    SELECT source_type,
           source_id,
           company_id,
           count(*) AS entries,
           array_agg(id ORDER BY entry_no DESC) FILTER (WHERE reversed_by IS NULL) AS unreversed,
           (array_agg(memo ORDER BY entry_no DESC))[1] AS memo,
           jsonb_agg(jsonb_build_object(
             'entry_no', entry_no,
             'entry_date', to_char(entry_date, 'YYYY-MM-DD'),
             'reversed_by', reversed_by
           ) ORDER BY entry_no) AS history
    FROM entries
    GROUP BY source_type, source_id, company_id
  ),
  kinds (source_type, tran_type) AS (
    VALUES ('item_fulfillment', 'ItemShip'), ('item_receipt', 'ItemRcpt'), ('inventory_adjustment', 'InvAdjst'),
           ('inventory_transfer', 'InvTrnfr'), ('assembly_build', 'Build'), ('assembly_unbuild', 'Unbuild')
  ),
  -- The invoices and credit memos the copy still has a cost line of for the company, read once, and only when the journal
  -- holds a cost entry; each document is looked up in them.
  cost_documents AS MATERIALIZED (
    SELECT DISTINCT c.transaction_id
    FROM public.gl_netsuite_cost_lines(p_company, NULL) c
    WHERE EXISTS (SELECT 1 FROM docs d WHERE d.source_type = 'invoice_cost')
  )
  SELECT jsonb_build_object('documents', coalesce(jsonb_agg(jsonb_build_object(
    'source_type', d.source_type,
    'source_id', d.source_id,
    'entries', d.entries,
    'unreversed', to_jsonb(coalesce(d.unreversed, ARRAY[]::uuid[])),
    'history', d.history,
    'current', (
      SELECT jsonb_build_object(
        'id', e.id,
        'entry_no', e.entry_no,
        'entry_date', to_char(e.entry_date, 'YYYY-MM-DD'),
        'lines', CASE WHEN p_lines THEN (
          SELECT coalesce(jsonb_agg(jsonb_build_object(
            'account', a.netsuite_account_id,
            'debit', l.debit::text,
            'credit', l.credit::text,
            'division', l.division,
            'source_line_ref', l.source_line_ref,
            'customer_id', l.customer_id,
            'vendor_ref', l.vendor_ref
          ) ORDER BY l.line_no), '[]'::jsonb)
          FROM public.gl_lines l
          JOIN public.gl_accounts a ON a.id = l.account_id
          WHERE l.entry_id = e.id
        ) END
      )
      FROM public.gl_entries e
      WHERE e.id = d.unreversed[1]
    ),
    'document', jsonb_build_object(
      'number', coalesce((SELECT t.tranid FROM public.gl_netsuite_transactions t WHERE t.netsuite_id = d.source_id), d.memo),
      'deleted', CASE WHEN d.source_type = 'invoice_cost'
        THEN cd.transaction_id IS NULL
        ELSE NOT EXISTS (
          SELECT 1
          FROM public.gl_netsuite_lines l
          JOIN public.gl_netsuite_transactions t ON t.netsuite_id = l.transaction_id
          JOIN kinds k ON k.tran_type = t.tran_type
          WHERE l.transaction_id = d.source_id
            AND l.company_id = d.company_id
            AND k.source_type = d.source_type
        )
      END
    )
  ) ORDER BY d.source_id, d.source_type), '[]'::jsonb))
  FROM docs d
  LEFT JOIN cost_documents cd ON d.source_type = 'invoice_cost' AND cd.transaction_id = d.source_id
$$;

-- Same access as migration 395 gave it: the service role only.
DO $$
DECLARE
  r TEXT;
BEGIN
  REVOKE ALL ON FUNCTION public.gl_stock_postings(text, text[], boolean) FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_stock_postings(text, text[], boolean) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.gl_stock_postings(text, text[], boolean) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_stock_postings(text, text[], boolean) IS 'Migration 395, with 397''s single read of the copy''s cost lines: what one company''s journal holds for its NetSuite stock documents (the entry that stands and its lines, every earlier entry and its reversal) and what the copy of NetSuite''s GL says of each now. Service role only.';
