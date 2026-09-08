-- R5-14: Portal billing tab — invoice-keyed customer threads.
-- customer_threads.context_entity_type only allowed
-- fleet_checkin/purchase_order/graphics_job/estimate/general (m078), and
-- context_entity_id is a UUID while NetSuite invoice ids/tranids are text.
-- Widen the CHECK and add a text ref so a portal "question about this
-- invoice?" lands in /admin/inbox keyed to the exact invoice.

ALTER TABLE customer_threads DROP CONSTRAINT IF EXISTS customer_threads_context_entity_type_check;
ALTER TABLE customer_threads ADD CONSTRAINT customer_threads_context_entity_type_check
  CHECK (context_entity_type IN ('fleet_checkin', 'purchase_order', 'graphics_job', 'estimate', 'general', 'invoice'));

ALTER TABLE customer_threads ADD COLUMN IF NOT EXISTS context_ref TEXT;

COMMENT ON COLUMN customer_threads.context_ref IS
  'Text reference for contexts whose ids are not UUIDs — e.g. the NetSuite invoice tranid for context_entity_type=invoice (R5-14).';
