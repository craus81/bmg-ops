-- Migration 307: per-type notification channel choices (R6-13).
--
-- Preferences were resolved by SUBSTRING MATCH on the notification type
-- string — type.includes('new') consulted notify_new_job,
-- type.includes('ready') consulted notify_ready — with everything matching
-- nothing falling through to "allowed". The Settings page therefore showed
-- four switches that between them governed three of the ~64 types the app
-- actually sends, silenced one contract-installer alert from a graphics
-- toggle, and offered a "Shipped" switch that governs nothing at all (no
-- type in the codebase contains that word).
--
-- type_channels is the honest replacement: an explicit per-type choice,
-- keyed by the type name from src/lib/notification-registry.ts.
--
--   absent key  → follow the account-wide in-app/email switches, so a user
--                 who never opens the new matrix keeps exactly the
--                 behaviour they have today.
--   []          → send me nothing of this type. A real choice, and
--                 distinct from absent.
--
-- The old columns are deliberately NOT dropped. notify_new_po,
-- notify_ready_for_install, notify_invoicing, email_mentions and
-- notify_weekly_brief pick the AUDIENCE at their call sites (who is
-- targeted at all), which is a different question from which channels a
-- targeted person hears it on; and notify_in_app / notify_email remain the
-- account-wide default this column overrides per type.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS type_channels JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN notification_preferences.type_channels IS
  'Per-notification-type channel choice: {"quote_followup":["in_app","push"]}. Keys come from src/lib/notification-registry.ts. An absent key follows the account-wide switches; an empty array means send nothing of that type.';
