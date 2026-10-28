-- Job numbers skip ones already in use (Craig, 2026-10-27).
--
-- Saving a new Graphics Builder worksheet failed with: duplicate key value
-- violates unique constraint "wrap_quotes_quote_number_key". The page asks
-- next_job_number('WQ') for a number, and on a clash asks once more; both
-- numbers were already taken, so the per-month counter in
-- job_number_sequences had fallen behind the numbers really in the table.
-- Once that happens every new worksheet fails until the counter catches up
-- on its own, one failed save at a time.
--
-- next_job_number() now keeps counting until it reaches a number nobody
-- has, checking the table each prefix lands in. A counter that is behind
-- jumps past the used numbers on the first call, so nothing else needs
-- re-seeding, and the counter never goes backwards. Prefixes with no known
-- table (none today) behave exactly as before.

CREATE OR REPLACE FUNCTION public.next_job_number(p_prefix TEXT)
RETURNS TEXT AS $$
DECLARE
  v_prefix TEXT := upper(trim(p_prefix));
  v_period TEXT := to_char(now(), 'YYMM');
  v_seq INT;
  v_number TEXT;
  v_taken BOOLEAN;
  v_tries INT := 0;
BEGIN
  IF v_prefix !~ '^[A-Z]{2,4}$' THEN
    RAISE EXCEPTION 'invalid job number prefix: %', p_prefix;
  END IF;
  LOOP
    INSERT INTO public.job_number_sequences AS s (prefix, period, last_seq)
    VALUES (v_prefix, v_period, 1)
    ON CONFLICT (prefix, period)
    DO UPDATE SET last_seq = s.last_seq + 1
    RETURNING last_seq INTO v_seq;
    -- lpad() TRUNCATES beyond the target length — greatest() lets the rare
    -- 1000th-in-a-month number widen to 4 digits instead of corrupting.
    v_number := v_prefix || '-' || v_period || '-'
      || lpad(v_seq::TEXT, greatest(3, length(v_seq::TEXT)), '0');

    v_taken := CASE
      WHEN v_prefix = 'WQ' THEN EXISTS (SELECT 1 FROM public.wrap_quotes WHERE quote_number = v_number)
      WHEN v_prefix = 'EST' THEN EXISTS (SELECT 1 FROM public.estimates WHERE estimate_number = v_number)
      WHEN v_prefix IN ('GFX', 'PRF', 'INT', 'CSG') THEN EXISTS (SELECT 1 FROM public.graphics_jobs WHERE job_number = v_number)
      WHEN v_prefix = 'PRQ' THEN EXISTS (SELECT 1 FROM public.pricing_requests WHERE request_number = v_number)
      ELSE false
    END;
    EXIT WHEN NOT v_taken;

    v_tries := v_tries + 1;
    IF v_tries >= 10000 THEN
      RAISE EXCEPTION 'no free % job number this month after % tries', v_prefix, v_tries;
    END IF;
  END LOOP;
  RETURN v_number;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = '';

GRANT EXECUTE ON FUNCTION public.next_job_number(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.next_job_number(TEXT) TO service_role;
