-- Migration 095: Persistent per-user chat history for FleetSuite AI.
--
-- One rolling conversation per user. Messages survive page refresh, sign
-- out / sign back in, and device switches so users don't have to re-state
-- context every session. "New Chat" deletes the user's rows; the table
-- naturally grows otherwise.

CREATE TABLE IF NOT EXISTS ai_chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_history_user_created
  ON ai_chat_history (user_id, created_at DESC);

ALTER TABLE ai_chat_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own ai chat history"
  ON ai_chat_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own ai chat history"
  ON ai_chat_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users delete own ai chat history"
  ON ai_chat_history FOR DELETE
  USING (auth.uid() = user_id);
