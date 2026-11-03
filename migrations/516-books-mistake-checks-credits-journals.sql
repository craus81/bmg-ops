-- Migration 516: FleetSuite's own books, a gap fixed: the mistake checks look
-- at bill credits, card refunds and journal entries too.
--
-- NetSuite Exit Checklist, "Gaps in what's built" (thread "Replacing NetSuite
-- with FleetSuite", 2026-11-03): the nightly mistake checks (migration 431,
-- docs/books.md "Mistake checks") flagged only the bills, checks and card
-- charges the copies of NetSuite hold. The bill credits and card refunds were
-- in what gl_mistake_docs hands the look, and left alone; NetSuite's journal
-- entries weren't handed over at all. Now the look
-- (src/lib/books/mistake-checks.ts) flags a bill credit or card refund
-- entered twice or coded to an account odd for the vendor, a bill credit for
-- more than the vendor billed in the year before it, and a journal entry
-- entered twice, or ten times (or a tenth of) what the same entry has
-- steadily come to. The four kinds of mistake stay as they were, so the
-- items, clearing and the page need nothing new here.
--   * gl_mistake_journal_entries(from, to), NetSuite's journal entries dated
--     in those days as the copy of its general ledger (migration 361) holds
--     them, each with its lines: the company, account, name, debit and credit
--     of each. One the copy holds no line of isn't there, as with the books'
--     own posting of them (migration 393). Nothing is written.
--
-- Writer and reader: the service role only, as migration 431 left the rest.

-- ── What the check looks through: NetSuite's journal entries ───────────────

-- NetSuite's journal entries ('Journal') dated from p_from up to p_to, as the
-- copy of its general ledger holds them, oldest first, each with:
--   number: NetSuite's, NULL when it has none;
--   lines:  its lines in NetSuite's order: company (its code), account (as
--           NetSuite's id), entity (NetSuite's id for the line's name, NULL
--           when it has none), and debit and credit (decimal strings).
CREATE OR REPLACE FUNCTION public.gl_mistake_journal_entries(p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'netsuite_id', t.netsuite_id,
    'number', t.tranid,
    'date', to_char(t.trandate, 'YYYY-MM-DD'),
    'lines', (
      SELECT jsonb_agg(jsonb_build_object(
        'company', c.code,
        'account', l.netsuite_account_id,
        'entity', l.entity_id,
        'debit', l.debit::text,
        'credit', l.credit::text
      ) ORDER BY l.line_id::bigint)
      FROM public.gl_netsuite_lines l
      JOIN public.gl_companies c ON c.id = l.company_id
      WHERE l.transaction_id = t.netsuite_id
    )
  ) ORDER BY t.trandate, t.netsuite_id::bigint), '[]'::jsonb)
  FROM public.gl_netsuite_transactions t
  WHERE t.tran_type = 'Journal'
    AND t.trandate >= p_from
    AND t.trandate < p_to
    AND EXISTS (SELECT 1 FROM public.gl_netsuite_lines l WHERE l.transaction_id = t.netsuite_id)
$$;

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  r TEXT;
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.gl_mistake_journal_entries(date, date) FROM PUBLIC';
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.gl_mistake_journal_entries(date, date) FROM %I', r);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.gl_mistake_journal_entries(date, date) TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION public.gl_mistake_journal_entries(date, date) IS 'Migration 516: NetSuite''s journal entries dated in some days, as the copy of its general ledger holds them, each with the company, account, name, debit and credit of each line, for the mistake checks. Service role only.';
COMMENT ON TABLE gl_mistake_checks IS 'Migration 431: each likely mistake the nightly mistake checks found in the copies of NetSuite''s bills, checks and card charges (src/lib/books/mistake-checks.ts), and since migration 516 its bill credits, card refunds and journal entries, by the key the check finds it by, open until a super admin clears it or the copies no longer show it. Written only by gl_mistake_checks_save, gl_mistake_check_clear and gl_mistake_check_reopen. Service-role write and read.';
