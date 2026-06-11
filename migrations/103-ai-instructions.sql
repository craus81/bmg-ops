-- Migration 096: Operator-editable instructions for FleetSuite AI.
--
-- Replaces the workflow of "ask the dev to update the system prompt"
-- with a self-serve table any admin can write to from /admin/settings/ai.
-- Each enabled row is appended to the AI's system prompt at request
-- time so behavior changes with no deploy.
--
-- scope = 'global' rules apply to every user. scope = 'user' rules
-- apply only when user_id = the requesting user. Order is preserved
-- by sort_order (low → high) so admins can put critical rules first.

CREATE TABLE IF NOT EXISTS ai_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL CHECK (scope IN ('global', 'user')),
  -- Required when scope = 'user'; ignored otherwise.
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Free-form instruction text. Treated as authoritative by the AI;
  -- prepended into the system prompt as "OPERATOR INSTRUCTIONS".
  content text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (scope = 'global' OR user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ai_instructions_scope_enabled
  ON ai_instructions (scope, enabled, sort_order);
CREATE INDEX IF NOT EXISTS idx_ai_instructions_user
  ON ai_instructions (user_id) WHERE scope = 'user';

ALTER TABLE ai_instructions ENABLE ROW LEVEL SECURITY;

-- Any signed-in user can read enabled global rules — they affect all
-- chats, so users should be able to see what shaped a response.
CREATE POLICY "Anyone reads enabled global ai instructions"
  ON ai_instructions FOR SELECT
  USING (scope = 'global' AND enabled = true);

-- Users see their own user-scoped rules (enabled or not, so they can
-- toggle them in their own settings page later).
CREATE POLICY "Users read own ai instructions"
  ON ai_instructions FOR SELECT
  USING (scope = 'user' AND auth.uid() = user_id);

-- Users manage their own user-scoped rules.
CREATE POLICY "Users insert own ai instructions"
  ON ai_instructions FOR INSERT
  WITH CHECK (scope = 'user' AND auth.uid() = user_id);

CREATE POLICY "Users update own ai instructions"
  ON ai_instructions FOR UPDATE
  USING (scope = 'user' AND auth.uid() = user_id)
  WITH CHECK (scope = 'user' AND auth.uid() = user_id);

CREATE POLICY "Users delete own ai instructions"
  ON ai_instructions FOR DELETE
  USING (scope = 'user' AND auth.uid() = user_id);

-- Admins can read, write, and disable global rules. Admin check uses
-- the same profiles.role pattern other admin policies in this codebase
-- use.
CREATE POLICY "Admins read all ai instructions"
  ON ai_instructions FOR SELECT
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins write global ai instructions"
  ON ai_instructions FOR INSERT
  WITH CHECK (
    scope = 'global'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins update global ai instructions"
  ON ai_instructions FOR UPDATE
  USING (
    scope = 'global'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  )
  WITH CHECK (
    scope = 'global'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "Admins delete global ai instructions"
  ON ai_instructions FOR DELETE
  USING (
    scope = 'global'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
