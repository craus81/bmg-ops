-- Native (APNs) device tokens for the iOS/iPadOS app. Web push covers
-- browsers via push_subscriptions; the Capacitor app's WKWebView has no Web
-- Push, so notifications reach it through Apple's APNs using these tokens.
-- Registered by /api/push/register-native when the app starts; consumed by
-- lib/notify's push channel; stale tokens (APNs 410/BadDeviceToken) are
-- deleted on send.
CREATE TABLE IF NOT EXISTS native_push_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'ios',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_native_push_tokens_user ON native_push_tokens(user_id);
-- A device token belongs to exactly one user (last login wins).
CREATE UNIQUE INDEX IF NOT EXISTS idx_native_push_tokens_token ON native_push_tokens(token);

-- RLS: written via the service role (API route); no client access needed.
ALTER TABLE native_push_tokens ENABLE ROW LEVEL SECURITY;
