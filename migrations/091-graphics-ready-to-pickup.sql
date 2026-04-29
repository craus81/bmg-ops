-- Migration 091: Add 'ready_to_pickup' graphics status
--
-- New status between 'ready' and 'shipped' for jobs where the customer
-- will come to BMG to pick up graphics rather than having them shipped.
-- Treated as an active status (not terminal) — the job stays on the active
-- board until the customer actually picks up, at which point graphics
-- team moves it to 'shipped' (interpreted as "handed off").

ALTER TABLE graphics_jobs DROP CONSTRAINT IF EXISTS graphics_jobs_status_check;
ALTER TABLE graphics_jobs ADD CONSTRAINT graphics_jobs_status_check
  CHECK (status IN (
    'flagged',
    'received',
    'designing',
    'revision',
    'printing',
    'outgassing',
    'cutting',
    'packing',
    'ready',
    'ready_to_pickup',
    'shipped',
    'installed',
    'cancelled'
  ));
