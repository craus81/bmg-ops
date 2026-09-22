-- Migration 320: let an estimate hold stock, not just an upfit project.
--
-- Reservations existed only for real jobs (project_id NOT NULL), so the
-- moment a salesperson quoted a build there was nothing stopping another
-- job from taking the parts off the shelf before the quote came back
-- approved. Quoting is where the promise is made, so quoting is where the
-- hold has to be available.
--
-- An allocation now belongs to EXACTLY ONE owner — an upfit project or an
-- estimate — enforced by num_nonnulls. Everything that sums the reserved
-- pool (readiness math, the inventory screen, incoming parts, reorder
-- suggestions) reads `status = 'reserved'` without caring who the owner is,
-- so an estimate hold reduces free stock exactly like a job hold. That is
-- the point: a hold that doesn't move the number it is meant to protect is
-- decoration.
--
-- NULLs are distinct in a Postgres unique index, so the existing
-- UNIQUE (project_id, item_number) keeps doing its job for project rows and
-- ignores estimate rows, and the new UNIQUE (estimate_id, item_number) does
-- the mirror. Both are plain (non-partial) constraints because PostgREST's
-- upsert can only infer a conflict target from column names.

ALTER TABLE part_allocations ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE part_allocations
  ADD COLUMN IF NOT EXISTS estimate_id UUID REFERENCES estimates(id) ON DELETE CASCADE;

ALTER TABLE part_allocations DROP CONSTRAINT IF EXISTS part_allocations_one_owner;
ALTER TABLE part_allocations
  ADD CONSTRAINT part_allocations_one_owner
  CHECK (num_nonnulls(project_id, estimate_id) = 1);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'part_allocations_estimate_id_item_number_key'
  ) THEN
    ALTER TABLE part_allocations
      ADD CONSTRAINT part_allocations_estimate_id_item_number_key
      UNIQUE (estimate_id, item_number);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_part_allocations_estimate
  ON part_allocations(estimate_id) WHERE estimate_id IS NOT NULL;

COMMENT ON COLUMN part_allocations.estimate_id IS
  'Set when this hold belongs to an estimate rather than an upfit project (migration 320). Exactly one of project_id / estimate_id is non-null.';

-- ── Releasing a quote hold ────────────────────────────────────────────────
--
-- A quote hold has to let go on its own, or the shelf fills with stock
-- reserved to quotes nobody ever revisits. Two endings retire it:
--
--   * the estimate becomes a sales order — the work is real now, and the
--     upfit project's readiness card owns the reservation from here. Without
--     this the same parts would be held twice, once by the quote and once by
--     the job, and free stock would read low by a whole build.
--   * the estimate is rejected — there is no job.
--
-- A trigger on `estimates` rather than a hook in the API, for the reason
-- migration 228 gives: four different paths stamp netsuite_so_id (the
-- convert-to-so route, link-so, create-sales-order, and the so-matchmaker
-- cron), and a hook in one of them is a hook missing from the other three.
-- Released, never consumed: an estimate never "uses" parts, the job does.
--
-- Deliberately NOT retired here: a superseded estimate (migration 243). A
-- re-quote does not always mean the original is dead, and guessing wrong
-- silently frees parts out from under a live promise. Release those by hand.

CREATE OR REPLACE FUNCTION public.estimate_allocations_on_close()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.netsuite_so_id IS NOT NULL AND OLD.netsuite_so_id IS NULL)
     OR (NEW.status = 'rejected' AND OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE part_allocations
    SET status = 'released',
        released_at = NOW(),
        updated_at = NOW()
    WHERE estimate_id = NEW.id AND status = 'reserved';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = public;

DROP TRIGGER IF EXISTS trg_estimate_allocations_on_close ON estimates;
CREATE TRIGGER trg_estimate_allocations_on_close
  AFTER UPDATE OF netsuite_so_id, status ON estimates
  FOR EACH ROW
  EXECUTE FUNCTION public.estimate_allocations_on_close();
