-- Quote open tracking (R6-9): who actually looked at a quote, and when.
--
-- The approval page's GET already runs server-side on every open, so this
-- needs no tracking pixel and no client cooperation — one row per open,
-- deduped inside a short window so a customer refreshing the page is one
-- view, not six.
--
-- viewer_kind is the point of the whole table. Corporate mail security
-- (Safe Links, Proofpoint, Mimecast) fetches every URL in an email, usually
-- within seconds of delivery — so the naive reading, "the customer opened
-- your quote 30 seconds after you sent it", is very often a robot. Every
-- fetch is recorded either way (it happened), but only the ones that look
-- like a person drive the alerts, and view_signal records WHICH signal
-- decided so a later change to the heuristic can be judged against what the
-- old one actually said.

CREATE TABLE IF NOT EXISTS quote_views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_type TEXT NOT NULL CHECK (quote_type IN ('estimate', 'wrap')),
  quote_id UUID NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  viewer_kind TEXT NOT NULL DEFAULT 'unverified'
    CHECK (viewer_kind IN ('human', 'bot', 'unverified')),
  view_signal TEXT,
  -- Set when this particular open produced a rep alert (first open, or a
  -- re-open after a quiet spell), so neither fires twice for the same open.
  notified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quote_views_quote
  ON quote_views (quote_type, quote_id, viewed_at DESC);

ALTER TABLE quote_views ENABLE ROW LEVEL SECURITY;

-- Written only by the service role (the public approval GET); read by staff.
DROP POLICY IF EXISTS "Staff can read quote_views" ON quote_views;
CREATE POLICY "Staff can read quote_views" ON quote_views FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND status = 'approved'
      AND (role IN ('admin', 'super_admin', 'sales') OR roles && ARRAY['admin', 'super_admin', 'sales'])
  ));

-- "Sent three days ago and nobody has opened it" is worth telling a rep once.
ALTER TABLE estimates ADD COLUMN IF NOT EXISTS never_opened_notified_at TIMESTAMPTZ;
ALTER TABLE wrap_quotes ADD COLUMN IF NOT EXISTS never_opened_notified_at TIMESTAMPTZ;

-- When this app started watching. For a quote SENT BEFORE this moment,
-- "nobody opened it" is UNKNOWN, not false — we were not looking — and the
-- never-opened alert must not claim otherwise. It also stops the first sweep
-- after deploy from telling every rep that every quote they ever sent was
-- ignored, which is both wrong and the fastest way to get an alert muted.
ALTER TABLE quote_settings ADD COLUMN IF NOT EXISTS view_tracking_started_at TIMESTAMPTZ;
UPDATE quote_settings SET view_tracking_started_at = NOW()
  WHERE id = 1 AND view_tracking_started_at IS NULL;

COMMENT ON COLUMN quote_views.viewer_kind IS
  'human = looks like a person in a browser; bot = a link scanner or non-browser fetch; unverified = arrived so soon after the send that it cannot be told apart from a scanner. Only human opens raise alerts.';
COMMENT ON COLUMN quote_views.view_signal IS
  'Which signal set viewer_kind (src/lib/quote-views.ts). Stored so a later change to the heuristic can be judged against what the old one actually said.';
