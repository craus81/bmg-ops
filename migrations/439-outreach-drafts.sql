-- Migration 439: Outreach, part 3 — a researched email draft per company,
-- which the rep reads, edits and sends from the standard compose screen.
--
-- Owner decision 2026-10-25 (thread "AI outbound sales agent", "Ship it"):
-- Claude reads each company's website and listing, picks what fits BMG, and
-- writes a short first email in the rep's name. Nothing sends itself: the
-- draft only fills the compose screen, and Send is the rep's (CLAUDE.md,
-- "No customer email sends itself"). The first send makes the company a
-- prospect (source 'outreach', created_by = the rep) and logs the email on
-- its timeline. Companies with no email found go to 'call_first'.

ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS draft_subject TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS draft_body TEXT;
-- Short "why this company" lines shown above the draft.
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS draft_reasons JSONB;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS drafted_at TIMESTAMPTZ;
-- Why the last draft try failed, in words, so the row can say so in red.
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS draft_error TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS sent_subject TEXT;

COMMENT ON COLUMN outreach_targets.draft_body IS
  'Claude''s first-email draft for the rep to review; never sent without the rep pressing Send.';
