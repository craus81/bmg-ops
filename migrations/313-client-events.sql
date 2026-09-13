-- Migration 313: client_events — browser-side usage instrumentation (R7-4).
-- Until now nothing recorded client-side errors, slow pages/routes, or forms
-- people start and abandon; audit_log / cron_runs / email_log are all
-- server-side. This is an append-only diagnostics log written ONLY by the
-- service role via POST /api/client-events (batched beacons from
-- src/components/UsageTelemetry.tsx), read by GET /api/admin/client-events
-- (System Health → Usage tab), and purged nightly by
-- /api/cron/client-events-purge after 30 days.
--
-- Idempotent: preview builds skip migrations, and a re-deploy re-runs the
-- pipeline.

CREATE TABLE IF NOT EXISTS client_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL CHECK (kind IN (
                'error', 'slow_page', 'page_timing', 'api_slow',
                'form_start', 'form_submit', 'form_abandon', 'queue_overflow')),
  -- Templated pathname only: /vehicles/:vin, /book/:token, /admin/pos/:id …
  page        TEXT NOT NULL CHECK (char_length(page) <= 200),
  form_id     TEXT CHECK (char_length(form_id) <= 60),
  -- The sanitizer caps detail at 4 KB of COMPACT json; jsonb's text form
  -- pads a space after every ':' and ',', so this backstop is 2x. A row
  -- over it is a sanitizer bug, not a big stack.
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(detail::text) <= 8192),
  -- NULL = a token was presented but could not be verified / the profile
  -- read failed (unknown). 'anonymous' = no token presented at all
  -- (public booking / credit-application pages). Never a client-supplied
  -- value and never a guess.
  role        TEXT CHECK (char_length(role) <= 40),
  -- Per-page-load random UUID kept only in browser memory; not a cookie,
  -- does not survive a reload, identifies nobody.
  session_id  UUID NOT NULL,
  -- Coarse device class derived server-side from the User-Agent header:
  -- ios-webview | ios-safari | android-webview | android-chrome | desktop | other.
  ua_family   TEXT CHECK (char_length(ua_family) <= 20),
  -- Browser clock when the event happened (batches arrive up to 20 s later,
  -- pagehide beacons later still). NULL = unknown / implausible.
  client_ts   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_client_events_created ON client_events (created_at, id);
CREATE INDEX IF NOT EXISTS idx_client_events_kind_created ON client_events (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_events_form ON client_events (form_id, created_at DESC) WHERE form_id IS NOT NULL;

COMMENT ON TABLE client_events IS
  'Browser usage/friction events: uncaught errors, slow pages, slow or failing API calls, form start/submit/abandon (R7-4). '
  'Deliberately NOT stored: user_id or any per-person identifier (the app runs on shared shop tablets — this is not an employee activity log); '
  'IP addresses; the raw User-Agent string (only a coarse ua_family); query strings or hashes of any URL; '
  'credentials, magic-link or e-sign tokens (templated to :token before insert); VINs (templated to :vin in paths, masked to [vin] in text); '
  'form field VALUES or field names (the client never reads input.value and counts touched fields by element reference only); '
  'e-mail addresses, phone numbers, digit runs, quoted or parenthesised text inside messages (masked client- AND server-side). '
  'Rows are purged after 30 days by the client_events_purge cron. '
  'A gap in this table is NOT evidence that nothing went wrong: ad-blockers, offline devices, NEXT_PUBLIC_TELEMETRY=off, rate limiting, or a dropped beacon all produce silence.';
COMMENT ON COLUMN client_events.page IS 'Templated pathname only (no query, no hash), max 200 chars. Dynamic segments are :id / :vin / :token.';
COMMENT ON COLUMN client_events.form_id IS 'Only for form_* kinds: the data-form / useFormTelemetry id (vehicle_checkin, estimate_builder, …).';
COMMENT ON COLUMN client_events.detail IS 'Bounded (<= 4 KB) per-kind payload, allowlisted and masked server-side. error: {message, source, line, col, stack, count, rejection}. slow_page/page_timing: {ms, lcp_ms, nav, weight, requests, capped}. api_slow: {route, method, ms, status, failed, offline}. form_*: {attempt_id, seconds_open, fields_touched (COUNT only), step, exit}. queue_overflow: {dropped}.';
COMMENT ON COLUMN client_events.role IS 'profiles.role of the caller, resolved server-side from the session token. NULL = token presented but not verifiable (unknown). anonymous = no token presented.';
COMMENT ON COLUMN client_events.ua_family IS 'Coarse device class from the request User-Agent header; the raw string is never stored.';

ALTER TABLE client_events ENABLE ROW LEVEL SECURITY;
-- Service-role only: the browser never reads or writes this table directly;
-- all access is through the API routes above.
DROP POLICY IF EXISTS "Service role can manage client_events" ON client_events;
CREATE POLICY "Service role can manage client_events" ON client_events
  FOR ALL USING (auth.role() = 'service_role');
