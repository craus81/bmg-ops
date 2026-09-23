-- New Event's Type now picks the same categories as the Schedule page's
-- filter chips, so a hand-made event shows under the chip it was filed as.
--
-- The old types (meeting/call/reminder/deadline/other) were saved but never
-- shown or filtered on, so every hand-made event landed under "Event". They
-- stay allowed so existing rows (and the Google import's 'other') keep
-- validating; the board reads anything outside the categories as "Event".

ALTER TABLE calendar_events DROP CONSTRAINT IF EXISTS calendar_events_event_type_check;
ALTER TABLE calendar_events
  ADD CONSTRAINT calendar_events_event_type_check
  CHECK (event_type IN (
    'event', 'graphics', 'upfit', 'pickup', 'cni', 'sales',
    'meeting', 'call', 'reminder', 'deadline', 'other'
  ));
ALTER TABLE calendar_events ALTER COLUMN event_type SET DEFAULT 'event';
