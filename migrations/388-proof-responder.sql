-- Migration 388: who answered a proof.
--
-- Owner request 2026-10-16 (thread "Who sent the change request"): a proof
-- email went to four people on one shared link, and the job page could not
-- say which of them asked for changes. Proof emails now go one per
-- recipient, each link naming its person, and the approval page records
-- who responded ("Name (email)", or the name a forwarded reader typed).
--
-- graphics_jobs keeps the latest decision, like the customer_approved_*
-- columns beside it; graphics_proof_rounds keeps it per round for history.
-- NULL = not known (responses made on the older shared links).

ALTER TABLE graphics_jobs
  ADD COLUMN IF NOT EXISTS customer_responder TEXT;

ALTER TABLE graphics_proof_rounds
  ADD COLUMN IF NOT EXISTS responded_by TEXT;

COMMENT ON COLUMN graphics_jobs.customer_responder IS 'Who approved or requested changes on the latest proof: "Name (email)" from their own link, or the name they typed. NULL = not known.';
COMMENT ON COLUMN graphics_proof_rounds.responded_by IS 'Who approved or requested changes in this round. NULL = not known.';
