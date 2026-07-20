-- Migration 168: Link graphics jobs to wrap quotes
-- A wrap quote can now spawn a graphics production job directly (the same
-- way estimates do via migration 072's estimate_id), closing the gap where
-- an accepted wrap quote had to be retyped into the graphics board by hand.
-- The link powers the "Create Graphics Job" action on the wrap quote screen
-- and the job badge in quote history.

ALTER TABLE graphics_jobs ADD COLUMN IF NOT EXISTS wrap_quote_id UUID REFERENCES wrap_quotes(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_graphics_jobs_wrap_quote ON graphics_jobs(wrap_quote_id);
