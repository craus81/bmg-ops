-- Migration 088: Add 'picked_up' graphics status
--
-- Terminal status for jobs the customer collected in person, distinct from
-- 'shipped' (handed off to a carrier) and 'installed' (BMG installed it).
-- Previously, customer-pickup jobs were flipped to 'shipped' on hand-off,
-- which muddied reporting. This separates the two paths.

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
    'picked_up',
    'installed',
    'cancelled'
  ));
