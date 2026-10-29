-- Migration 452: who opened an estimate, and 👀 alerts that open it.
--
-- Craig (2026-10-29, thread "Open the estimate from an Opened alert"):
--   1. Tapping a 👀 Opened alert (or a follow-up reminder) landed on the
--      Estimates list. New ones open the estimate itself; this points the
--      ones already in people's bells at the estimate too.
--   2. An estimate sent to several people goes one email per person, each
--      link naming its reader (?to=…&own=1, migration 424). The open now
--      records that person, and each person's first look is its own alert.

ALTER TABLE quote_views ADD COLUMN IF NOT EXISTS viewer TEXT;

COMMENT ON COLUMN quote_views.viewer IS
  'Email or phone the per-person approval link was sent to (?to=…&own=1). Null on older shared links. A forwarded link still names the original recipient.';

UPDATE notifications
SET url = '/estimates?id=' || substring(url from '\?item=estimate-([0-9a-fA-F-]{36})') || '&from=quotes'
WHERE type = 'quote_followup'
  AND url ~ '^/(estimates|quotes)\?item=estimate-[0-9a-fA-F-]{36}$';
