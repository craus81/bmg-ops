-- Migration 387: FleetSuite's own books — documents copied from NetSuite
-- post to the accounts NetSuite used, even ones it has made inactive since.
--
-- Owner decision 2026-10-16 (thread "Replacing NetSuite with FleetSuite",
-- "Post them"): twelve 2025 bills from Apex Commercial post to 23700 Apex
-- Commercial - Printer Loan, an account NetSuite has made inactive since.
-- The chart of accounts follows NetSuite's inactive flags (migration 360),
-- and the journal's line check refused every account that's inactive now,
-- a rule written with typed entries in mind (migration 359), so those
-- bills couldn't post.
--
-- Now only a typed entry (source_type 'manual') is refused an inactive
-- account. An invoice, credit memo, payment, deposit, bill or bill credit
-- worked out from the copy of NetSuite's documents posts to the accounts
-- NetSuite posted it to, and the checks against NetSuite's general ledger
-- are what hold those entries to NetSuite. Opening balances, worked out
-- from the same copy, follow NetSuite's accounts too, and a reversal still
-- undoes whatever its original hit. Headings, another company's accounts
-- and control accounts on typed entries are refused as before.
--
-- Same function as migration 360 otherwise. CREATE OR REPLACE, so safe to
-- re-run; the trigger (migration 359) stays as it is. No table is added or
-- changed.

CREATE OR REPLACE FUNCTION public.gl_lines_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_entry public.gl_entries%ROWTYPE;
  v_account public.gl_accounts%ROWTYPE;
BEGIN
  SELECT * INTO v_entry FROM public.gl_entries WHERE id = NEW.entry_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: line for unknown entry %', NEW.entry_id;
  END IF;
  IF v_entry.posted_txid <> txid_current() THEN
    RAISE EXCEPTION 'gl: entry % is already posted; lines can only be added while it is being posted', v_entry.entry_no;
  END IF;

  SELECT * INTO v_account FROM public.gl_accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gl: unknown account %', NEW.account_id;
  END IF;
  -- Only a typed entry is refused an inactive account. A document copied
  -- from NetSuite posts where NetSuite posted it, and a reversal (never
  -- 'manual') may hit an account deactivated since the original posted.
  IF NOT v_account.active AND v_entry.source_type = 'manual' THEN
    RAISE EXCEPTION 'gl: account % (%) is inactive', v_account.number, v_account.name;
  END IF;
  IF v_account.is_summary AND v_entry.reverses_entry_id IS NULL THEN
    RAISE EXCEPTION 'gl: account % (%) is a heading; post to an account under it', v_account.number, v_account.name;
  END IF;
  IF v_account.company_id IS NOT NULL AND v_account.company_id <> v_entry.company_id THEN
    RAISE EXCEPTION 'gl: account % (%) belongs to another company', v_account.number, v_account.name;
  END IF;
  IF v_account.is_control AND v_entry.source_type = 'manual' THEN
    RAISE EXCEPTION 'gl: account % (%) is posted only by its own documents, not by a typed entry', v_account.number, v_account.name;
  END IF;

  NEW.company_id := v_entry.company_id;
  NEW.entry_date := v_entry.entry_date;
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN gl_accounts.active IS 'Follows NetSuite''s inactive flag until the changeover. A typed (source_type = ''manual'') entry can''t post to an inactive account; documents copied from NetSuite, opening balances and reversals still can (migration 387).';
