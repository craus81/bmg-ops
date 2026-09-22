-- Migration 310: Google review requests on job completion (R6-13).
--
-- The completion email gains a "How did we do?" block. Two things have to
-- be recorded for that to be safe to send:
--
--   review_request_sent_at — the suppression stamp. Asking the same fleet
--     customer for a review on every vehicle they collect is how a review
--     request becomes spam; one ask per customer per six months.
--   review_request_suppressed — a permanent opt-out a human can set on a
--     customer we should never ask, whatever the cooldown says.
--
-- The review URL itself lives in app_settings under 'google_review' rather
-- than a new column: it is one company-wide value, service-role gated, and
-- app_settings is where the other integration config already lives.
--
-- WITH NO URL CONFIGURED THE BLOCK NEVER RENDERS. A "How did we do?"
-- heading with a dead link is worse than no block, so the absence of the
-- setting suppresses the whole feature rather than degrading it.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS review_request_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS review_request_suppressed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN customers.review_request_sent_at IS 'Last time a Google-review ask rode along on a completion email (R6-13). Enforces one ask per customer per six months.';
COMMENT ON COLUMN customers.review_request_suppressed IS 'Never ask this customer for a review, regardless of the cooldown — set by a human who knows why.';
