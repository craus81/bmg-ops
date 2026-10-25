-- Migration 437: unsubscribe links on prospect marketing email.
--
-- Owner decision 2026-10-25 (thread "AI outbound sales agent", "Ship it"):
-- FleetSuite will draft researched first emails to new fleets and trade
-- contractors for each rep to review and send. Commercial email has to
-- carry the sender's postal address and a working opt-out (CAN-SPAM), and
-- Gmail and Yahoo also want a one-click List-Unsubscribe header on bulk
-- mail. The segment email blast never had either, so this comes first.
--
-- One row per address we have sent marketing email to. The token is the
-- address's own unsubscribe link, minted on the first send and reused on
-- every later one, so an old email's link keeps working. unsubscribed_at
-- set means: never send this address marketing email again. Emails about
-- the customer's own orders (estimates, invoices) are not marketing and are
-- not gated by this.
--
-- Written and read only by the service role (src/lib/email-unsubscribe.ts);
-- RLS on with no policies keeps it off the browser client.

CREATE TABLE IF NOT EXISTS email_unsubscribes (
  email TEXT PRIMARY KEY CHECK (email = lower(btrim(email)) AND email <> ''),
  token TEXT NOT NULL UNIQUE,
  unsubscribed_at TIMESTAMPTZ,
  unsubscribed_via TEXT CHECK (unsubscribed_via IN ('page', 'one_click')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_unsubscribes_unsubscribed
  ON email_unsubscribes (email) WHERE unsubscribed_at IS NOT NULL;

ALTER TABLE email_unsubscribes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE email_unsubscribes IS
  'Marketing-email unsubscribe links, one per address. unsubscribed_at set = never send this address marketing email again (segment blasts, outreach).';
