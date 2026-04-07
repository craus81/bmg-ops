-- Migration: Per-user feature access overrides
-- Allows admins to grant or revoke specific features for individual users,
-- overriding the defaults from their role.

CREATE TABLE IF NOT EXISTS user_feature_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  granted BOOLEAN NOT NULL DEFAULT true, -- true = grant access, false = revoke
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, feature)
);

ALTER TABLE user_feature_overrides ENABLE ROW LEVEL SECURITY;

-- Admins can manage all overrides
CREATE POLICY "admin_manage_overrides" ON user_feature_overrides
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND (profiles.role = 'admin' OR profiles.roles @> '["admin"]')
    )
  );

-- Users can read their own overrides
CREATE POLICY "users_read_own_overrides" ON user_feature_overrides
  FOR SELECT USING (user_id = auth.uid());

CREATE INDEX idx_user_feature_overrides_user ON user_feature_overrides(user_id);
