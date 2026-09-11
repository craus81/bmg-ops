-- Quote expiry engine (R6-9): warn before a quote's approval link dies, and
-- tell the rep when it has.
--
-- There is deliberately NO new "valid until" date here. The date a customer
-- can no longer accept is already on the record — approval_token_expires_at,
-- set at send (30 days by default) and already enforced by the approval
-- routes, which 410 past it. Inventing a second validity date would give
-- every quote two expiry dates that can disagree, and the one printed in the
-- customer's email would not be the one the button obeys.
--
-- Each stamp stores the EXPIRY IT FIRED AGAINST rather than a bare
-- timestamp, so a re-send — which mints a new token with a new expiry —
-- re-arms both notices automatically. The alternative (clearing flags at
-- every mint site) needs every future caller to cooperate, and the CNI
-- compliance ladder already taught us what that costs.

ALTER TABLE estimates
  ADD COLUMN IF NOT EXISTS expiry_warned_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_notified_for TIMESTAMPTZ;

ALTER TABLE wrap_quotes
  ADD COLUMN IF NOT EXISTS expiry_warned_for TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expiry_notified_for TIMESTAMPTZ;

COMMENT ON COLUMN estimates.expiry_warned_for IS
  'The approval_token_expires_at value the pre-expiry warning was sent for. Differs from the current expiry (or NULL) = not yet warned for this link.';
COMMENT ON COLUMN estimates.expiry_notified_for IS
  'The approval_token_expires_at value the rep was told had expired. Differs from the current expiry (or NULL) = not yet notified for this link.';
COMMENT ON COLUMN wrap_quotes.expiry_warned_for IS
  'The approval_token_expires_at value the pre-expiry warning was sent for. See estimates.expiry_warned_for.';
COMMENT ON COLUMN wrap_quotes.expiry_notified_for IS
  'The approval_token_expires_at value the rep was told had expired. See estimates.expiry_notified_for.';
