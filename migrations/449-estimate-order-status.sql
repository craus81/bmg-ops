-- Migration 449: customer order status link on approved estimates.
--
-- Craig (2026-10-28, thread "Keep customers updated after approval"): once a
-- customer approves, nothing tells them it was received or where the job
-- stands. The rep now sends a "We got your approval" email (one tap, the
-- standard compose screen, never automatic) carrying a live Order status
-- link, /order/<token>, that moves through Approved → Parts ordered → All
-- parts in → Scheduled → In the shop → Done → Invoiced on its own.
--
-- "All parts in" is set by hand (Mark all parts in on the estimate): Craig
-- doesn't trust inventory or receiving to drive it yet.

ALTER TABLE estimates ADD COLUMN IF NOT EXISTS order_status_token UUID;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_confirmation_sent_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS approval_confirmation_sent_by UUID REFERENCES profiles(id) ON DELETE SET NULL;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS parts_all_in_at TIMESTAMPTZ;
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS parts_all_in_by UUID REFERENCES profiles(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_estimates_order_status_token
  ON estimates(order_status_token) WHERE order_status_token IS NOT NULL;
