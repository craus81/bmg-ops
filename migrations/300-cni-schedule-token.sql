-- Installer schedule feed: one subscribe-once calendar URL per CNI company.
--
-- R6-8. An installer's crew works out of their own calendar app, not our
-- console, so a confirmed BMG job that exists only on our schedule board is
-- a job nothing on their phone warns them about. This is the customer
-- PO-portal pattern (migration 260) aimed at a different audience: a token
-- that IS the credential on a read-only feed, issued and revoked from the
-- company record.
--
-- The columns live on `companies` rather than a CNI-only table because a
-- "CNI company" is just a companies row (migrations 110/192) — the same row
-- jobs are assigned to via cni_jobs.assigned_company_id. Nothing syncs this
-- table from NetSuite, so there is no clobber-on-resync concern here.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS schedule_token UUID,
  ADD COLUMN IF NOT EXISTS schedule_token_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS schedule_last_fetched_at TIMESTAMPTZ;

-- Unique so a token resolves to exactly one company; partial so the many
-- companies with no feed issued don't collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_schedule_token
  ON companies (schedule_token) WHERE schedule_token IS NOT NULL;

COMMENT ON COLUMN companies.schedule_token IS
  'Credential for this company''s installer schedule feed (GET /api/cni/schedule/<token>.ics). NULL = no feed issued. Regenerating replaces it (every existing subscription goes dead); revoking clears it.';
COMMENT ON COLUMN companies.schedule_token_created_at IS
  'When the current schedule_token was issued.';
COMMENT ON COLUMN companies.schedule_last_fetched_at IS
  'Last time a calendar client actually pulled the feed. This is how anyone can tell a subscription is live rather than merely issued — a link created weeks ago that was never fetched means nobody subscribed.';
