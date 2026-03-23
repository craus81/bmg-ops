-- In-App Messaging System
-- 1:1 direct messages between any users

-- ═══════════ CONVERSATIONS TABLE ═══════════
-- Each conversation is between exactly 2 users
CREATE TABLE IF NOT EXISTS conversations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  participant_1 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  participant_2 UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(participant_1, participant_2),
  CHECK (participant_1 < participant_2) -- enforce ordering to prevent duplicate convos
);

CREATE INDEX IF NOT EXISTS idx_conversations_p1 ON conversations(participant_1);
CREATE INDEX IF NOT EXISTS idx_conversations_p2 ON conversations(participant_2);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(last_message_at DESC);

-- ═══════════ MESSAGES TABLE ═══════════
CREATE TABLE IF NOT EXISTS messages (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ, -- null = unread by recipient
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(sender_id, read_at) WHERE read_at IS NULL;

-- ═══════════ RLS POLICIES ═══════════
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Conversations: participants can see their own conversations
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (participant_1 = auth.uid() OR participant_2 = auth.uid());

CREATE POLICY conversations_insert ON conversations FOR INSERT
  WITH CHECK (participant_1 = auth.uid() OR participant_2 = auth.uid());

CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (participant_1 = auth.uid() OR participant_2 = auth.uid());

-- Messages: participants of the conversation can see/send messages
CREATE POLICY messages_select ON messages FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );

CREATE POLICY messages_insert ON messages FOR INSERT
  WITH CHECK (
    sender_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );

-- Allow marking messages as read (only the recipient, not the sender)
CREATE POLICY messages_update ON messages FOR UPDATE
  USING (
    sender_id != auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_id
      AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );

-- ═══════════ ENABLE REALTIME ═══════════
-- Enable realtime on messages table for live updates
ALTER PUBLICATION supabase_realtime ADD TABLE messages;
