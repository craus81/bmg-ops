-- Migration 510: FleetSuite's own books, part 88 — how the books work,
-- written down.
--
-- The NetSuite Exit Checklist's "How the books work, written down" (thread
-- "Replacing NetSuite with FleetSuite", building every piece since
-- 2026-10-31): what posts what, who can change what and how backups work,
-- in words, kept current as the books are built, and every posting rule
-- reviewed by BMG's CPA. The IRS covers records kept in software in
-- Rev. Proc. 98-25, which asks for such a description. Books → How the
-- books work (src/lib/books/how-it-works.ts) writes it out from the code
-- that does the work, with what the books hold today, and as a PDF the CPA
-- can sign (docs/books.md "How the books work"). This adds:
--   * gl_posting_rule_use(), each company's journal entries counted by the
--     posting rule they were posted by, with how many of them have been
--     reversed and the first and last date, so the page says how much each
--     rule has posted and names any rule the journal holds that isn't
--     written down;
--   * books_rules_reviews, a row each time the CPA, or a super admin for a
--     review the CPA did on paper, marks the description reviewed: who, as
--     what, when, the posting rules it held then and a fingerprint of how
--     they were written, so the page shows what has changed since. A review
--     stays as it was made.
--
-- Nothing in the books changes, nothing is posted and nothing goes to
-- NetSuite. Writer and reader: the service role only.

-- ── What each posting rule has posted ──────────────────────────────────────

-- A reversal is posted by the rule 'reversal' (gl_reverse_entry, migration
-- 359), so it's counted with the entry it reverses, not as a rule of its own.
CREATE OR REPLACE FUNCTION public.gl_posting_rule_use()
RETURNS TABLE (company TEXT, posting_rule TEXT, entries BIGINT, reversed BIGINT, first_date DATE, last_date DATE)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT c.code, e.posting_rule, count(*)::bigint, count(r.id)::bigint, min(e.entry_date), max(e.entry_date)
  FROM public.gl_entries e
  JOIN public.gl_companies c ON c.id = e.company_id
  LEFT JOIN public.gl_entries r ON r.reverses_entry_id = e.id
  WHERE e.reverses_entry_id IS NULL
  GROUP BY c.code, e.posting_rule
  ORDER BY c.code, e.posting_rule;
$$;

-- ── The CPA's reviews ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS books_rules_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- profiles.id of who marked it, kept without a foreign key as the journal keeps who posted.
  reviewed_by UUID NOT NULL,
  reviewed_by_name TEXT NOT NULL CHECK (reviewed_by_name = btrim(reviewed_by_name) AND length(reviewed_by_name) BETWEEN 1 AND 200),
  -- The CPA, or a super admin writing down a review the CPA did on paper.
  reviewed_as TEXT NOT NULL CHECK (reviewed_as IN ('cpa', 'super_admin')),
  -- The posting rules the description held, each with its version: invoice@1.
  rules TEXT[] NOT NULL CHECK (
    cardinality(rules) BETWEEN 1 AND 200
    AND array_to_string(rules, ',', '?') ~ '^[a-z_]+@[0-9]+(,[a-z_]+@[0-9]+)*$'
  ),
  -- SHA-256 of how those rules were written down, so a change to the words shows too.
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  note TEXT CHECK (note IS NULL OR (note = btrim(note) AND length(note) BETWEEN 1 AND 600))
);
CREATE INDEX IF NOT EXISTS idx_books_rules_reviews_at ON books_rules_reviews (reviewed_at DESC, id);

-- A review stays as it was made.
CREATE OR REPLACE FUNCTION public.books_rules_reviews_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'books: a review of how the books work stays as it was made';
END;
$$;
DROP TRIGGER IF EXISTS books_rules_reviews_guard ON books_rules_reviews;
CREATE TRIGGER books_rules_reviews_guard BEFORE UPDATE OR DELETE ON books_rules_reviews
  FOR EACH ROW EXECUTE FUNCTION public.books_rules_reviews_guard();
DROP TRIGGER IF EXISTS books_rules_reviews_truncate_guard ON books_rules_reviews;
CREATE TRIGGER books_rules_reviews_truncate_guard BEFORE TRUNCATE ON books_rules_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.gl_truncate_guard();

-- The change history (migration 508): a review added outside FleetSuite is recorded, as on the rest of the books.
DROP TRIGGER IF EXISTS books_money_change ON books_rules_reviews;
CREATE TRIGGER books_money_change AFTER INSERT OR UPDATE OR DELETE ON books_rules_reviews
  FOR EACH ROW WHEN (public.books_change_via() IN ('database', 'screen'))
  EXECUTE FUNCTION public.books_money_change('id', '');

-- ── Access: service role only ──────────────────────────────────────────────

DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  ALTER TABLE public.books_rules_reviews ENABLE ROW LEVEL SECURITY;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.books_rules_reviews FROM %I', r);
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY['public.gl_posting_rule_use()', 'public.books_rules_reviews_guard()'] LOOP
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

COMMENT ON FUNCTION public.gl_posting_rule_use() IS 'Migration 510: each company''s journal entries counted by the posting rule they were posted by, with how many have been reversed and the first and last date (Books → How the books work, src/lib/books/how-it-works-data.ts). A reversal counts with the entry it reverses. Service role only.';
COMMENT ON TABLE books_rules_reviews IS 'Migration 510: each time the CPA, or a super admin for a review the CPA did on paper, marked Books → How the books work reviewed: who, as what, when, the posting rules it held and a fingerprint of how they were written down (src/lib/books/how-it-works.ts). Rows stay as they were made. Service-role write and read.';
