-- Allow any participant in a conversation to delete messages in that thread
-- Previously only admins could delete messages
DROP POLICY IF EXISTS "messages_delete" ON messages;

CREATE POLICY "messages_delete" ON messages
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND (c.participant_1 = auth.uid() OR c.participant_2 = auth.uid())
    )
  );
