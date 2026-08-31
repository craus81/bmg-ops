-- Migration 243: estimate revision lineage (Round 3 roadmap R3-17).
--
-- The revision lock (accepted/converted estimates are frozen) tells people
-- to "start a new estimate" but gave them no way to do it that keeps the
-- content. Duplicate does the copying; when the source is locked the copy
-- is stamped as a revision of it, so the builder can show "Revision of
-- EST-xxxx" on the draft and "Superseded by EST-yyyy" on the original,
-- and ops can tell a re-quote from an unrelated estimate.
--
-- ON DELETE SET NULL: deleting the original (admin, audited) leaves the
-- revision standing as a plain estimate rather than blocking the delete.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS supersedes_estimate_id UUID REFERENCES estimates(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_estimates_supersedes ON estimates(supersedes_estimate_id) WHERE supersedes_estimate_id IS NOT NULL;
