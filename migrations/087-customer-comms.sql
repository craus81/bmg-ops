-- Migration 087: T1.5 Customer comms — threaded unified inbox
--
-- Creates three tables separate from the internal peer-to-peer messages
-- system. Internal chat (conversations + messages) stays untouched;
-- customer-facing communications live in their own schema with a
-- polymorphic entity-context reference so threads can be tagged to a
-- fleet check-in, purchase order, graphics job, or estimate.
--
-- BMG has no current customer SMS today — this is a greenfield build.
-- SMS dispatch is feature-flagged via SMS_PROVIDER_ENABLED in the app;
-- email paths work immediately.

-- ═══════════ external_contacts ═══════════
-- Represents a customer-side person we might text or email. Not a
-- profiles row (profiles is staff only). Tied to the synced customers
-- table by customer_id. is_unknown flags auto-created contacts from
-- inbound SMS that hasn't yet been tagged to a named person.
CREATE TABLE IF NOT EXISTS external_contacts (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  name TEXT,
  phone TEXT,
  email TEXT,
  title TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  channel_pref TEXT CHECK (channel_pref IN ('sms', 'email', 'phone')),
  is_unknown BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_external_contacts_phone ON external_contacts(phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_contacts_email ON external_contacts(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_external_contacts_customer ON external_contacts(customer_id) WHERE customer_id IS NOT NULL;

ALTER TABLE external_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read external contacts"
  ON external_contacts FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales','graphics_production','production','field_tech','shop_tech','installer'))
  );

CREATE POLICY "Admins and sales can manage external contacts"
  ON external_contacts FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  );

-- ═══════════ customer_threads ═══════════
-- Ongoing conversation with one external contact. Optionally tagged to
-- an ops entity (fleet_checkin, purchase_order, graphics_job, estimate),
-- or 'general' for catch-all chats. assigned_to tracks which staffer
-- owns the thread.
CREATE TABLE IF NOT EXISTS customer_threads (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  external_contact_id UUID NOT NULL REFERENCES external_contacts(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
  context_entity_type TEXT NOT NULL DEFAULT 'general'
    CHECK (context_entity_type IN ('fleet_checkin', 'purchase_order', 'graphics_job', 'estimate', 'general')),
  context_entity_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived')),
  assigned_to UUID REFERENCES profiles(id),
  subject TEXT,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  last_inbound_at TIMESTAMPTZ,
  unread_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_threads_contact ON customer_threads(external_contact_id);
CREATE INDEX IF NOT EXISTS idx_customer_threads_customer ON customer_threads(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_threads_entity ON customer_threads(context_entity_type, context_entity_id);
CREATE INDEX IF NOT EXISTS idx_customer_threads_assigned ON customer_threads(assigned_to) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_customer_threads_status_last ON customer_threads(status, last_message_at DESC);

ALTER TABLE customer_threads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read customer threads"
  ON customer_threads FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales','graphics_production','production','field_tech','shop_tech','installer'))
  );

CREATE POLICY "Admins and sales manage customer threads"
  ON customer_threads FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  );

-- ═══════════ customer_messages ═══════════
-- Individual messages in a thread. direction=outbound for SMS/MMS/email
-- we send; inbound for replies we receive. external_provider_sid holds
-- the provider-side message id (Twilio SID, RingCentral message id, etc.)
-- so we can correlate later status updates.
CREATE TABLE IF NOT EXISTS customer_messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES customer_threads(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'mms', 'email')),
  body TEXT,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  external_provider_sid TEXT,
  provider_name TEXT,
  sent_by UUID REFERENCES profiles(id),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  delivery_status TEXT CHECK (delivery_status IN ('pending', 'sent', 'delivered', 'failed', 'received'))
);

CREATE INDEX IF NOT EXISTS idx_customer_messages_thread ON customer_messages(thread_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_messages_sid ON customer_messages(external_provider_sid) WHERE external_provider_sid IS NOT NULL;

ALTER TABLE customer_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can read customer messages"
  ON customer_messages FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales','graphics_production','production','field_tech','shop_tech','installer'))
  );

CREATE POLICY "Admins and sales manage customer messages"
  ON customer_messages FOR ALL TO authenticated
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin','sales'))
  );

-- ═══════════ Trigger: bump customer_threads.last_message_at on insert ═══════════
CREATE OR REPLACE FUNCTION bump_customer_thread_on_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE customer_threads
  SET
    last_message_at = NEW.sent_at,
    last_inbound_at = CASE WHEN NEW.direction = 'inbound' THEN NEW.sent_at ELSE last_inbound_at END,
    unread_count = CASE WHEN NEW.direction = 'inbound' THEN unread_count + 1 ELSE unread_count END,
    updated_at = NOW()
  WHERE id = NEW.thread_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_bump_customer_thread_on_message ON customer_messages;
CREATE TRIGGER trg_bump_customer_thread_on_message
  AFTER INSERT ON customer_messages
  FOR EACH ROW EXECUTE FUNCTION bump_customer_thread_on_message();
