-- Migration 441: Outreach, part 5 — a follow-up draft a week after silence.
--
-- Owner decision 2026-10-25 (thread "AI outbound sales agent"): when a
-- company hasn't answered a week after its first Outreach email, Claude
-- writes a short follow-up and the rep reviews and sends it, same as the
-- first one. Nothing sends itself. "Answered" means anything we can see:
-- they booked a call or asked for one, the rep marked "They replied", or
-- someone logged a call, meeting or note on the prospect since the send.
-- One follow-up per company; after it the row rests at 'followed_up'.
--
-- followup_skipped records why a due row got no follow-up (already talked,
-- unsubscribed) so the drafting cron stops looking at it.

ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_subject TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_body TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_drafted_at TIMESTAMPTZ;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_error TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_skipped TEXT;
ALTER TABLE outreach_targets ADD COLUMN IF NOT EXISTS followup_sent_at TIMESTAMPTZ;

ALTER TABLE outreach_targets DROP CONSTRAINT IF EXISTS outreach_targets_status_check;
ALTER TABLE outreach_targets ADD CONSTRAINT outreach_targets_status_check CHECK (status IN (
  'new', 'draft', 'call_first', 'sent', 'follow_up', 'followed_up', 'replied', 'booked', 'call_back',
  'later', 'not_fit', 'unsubscribed'
));

CREATE INDEX IF NOT EXISTS idx_outreach_targets_sent ON outreach_targets (status, sent_at);
