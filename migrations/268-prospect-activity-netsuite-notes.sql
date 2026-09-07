-- Migration 268: prospect notes reach NetSuite (R3-16a's second half —
-- owner decision 2026-09-07: "notes can go to NetSuite for sure").
--
-- prospect_activities mixes what a person wrote (the composer's
-- call/email/note/meeting entries, voice notes) with what the app logged
-- (logAuto rows — which also use type 'note' — plus email-send logs and
-- customer quote responses). Only the human-authored rows belong on the
-- NetSuite customer as user notes, so `auto` marks app-generated rows
-- (the page's logAuto sets it going forward; email-send logs are excluded
-- by their email_log_id and quote responses by type, so those writers
-- stay column-free and can't break during schema-cache lag) and
-- `netsuite_note_id` stamps synced rows so a re-sync can't duplicate
-- ('created-id-unknown' sentinel when NetSuite creates the note but
-- returns no id).

ALTER TABLE prospect_activities ADD COLUMN IF NOT EXISTS auto BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE prospect_activities ADD COLUMN IF NOT EXISTS netsuite_note_id TEXT;

-- Backfill the flag for historical rows: system types, email-send logs
-- (email_log_id present), and the known logAuto summary shapes. A stray
-- system row left at auto=false merely syncs one harmless extra note.
UPDATE prospect_activities SET auto = true
WHERE auto = false AND (
  type IN ('status_change', 'quote_sent', 'quote_accepted', 'quote_rejected')
  OR email_log_id IS NOT NULL
  OR (type = 'note' AND (
       summary LIKE 'Added contact:%'
    OR summary LIKE 'Created opportunity:%'
    OR summary LIKE 'Reminder set:%'
    OR summary LIKE 'Added to the email-campaign list%'
    OR summary LIKE 'Removed from the email-campaign list%'
  ))
);

COMMENT ON COLUMN prospect_activities.auto IS
  'Migration 268: true = app-generated (logAuto entries, email-send logs, quote responses) — excluded from the NetSuite notes sync.';
COMMENT ON COLUMN prospect_activities.netsuite_note_id IS
  'Migration 268: NetSuite user-note internal id once synced (created-id-unknown when the create returned no id). NULL = not yet pushed.';
