-- Migration 357: Team chat on each order (owner ask 2026-10-09, from Valarie).
--
-- Staff wanted a way to talk to each other about an order in process
-- besides the estimate's single Internal Notes box. Each estimate gets a
-- running team chat; it is the same record once the estimate becomes a
-- sales order, so the conversation carries over. The same chat shows on
-- the In-Shop vehicle card when the vehicle is linked to the estimate, and
-- on its own page (/order-chat/<estimate id>) that every internal role can
-- open, so a shop or field tech without the Estimates page can still read
-- and answer it.
--
-- Owner decisions: all internal staff can read and post; customers and CNI
-- installers never see it. A new message pings (push + in-app, no email)
-- the estimate's sales rep (estimates.created_by), everyone who has posted
-- in that chat, anyone who tapped Follow, and anyone @tagged (they get the
-- usual mention instead). Unfollow stops the pings.
--
-- Writes go through /api/order-chat (service role, requireStaff). The
-- SELECT policies exist only so the browser's realtime subscription
-- delivers new messages to an open chat.

CREATE TABLE IF NOT EXISTS order_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_chat_messages_estimate_idx
  ON order_chat_messages (estimate_id, created_at, id);

-- One row per person per order chat: whether they get pinged, and how far
-- they have read (unread counts for the Messages → Orders tab). The rep's
-- row is added with the chat's first message so it lists for them too.
--   following = true  → pinged on every new message (posted, @tagged, or
--                       tapped Follow)
--   following = false → tapped Unfollow; posting or being @tagged again
--                       follows them back
--   following = NULL  → only opened it; the sales rep is still pinged
CREATE TABLE IF NOT EXISTS order_chat_members (
  estimate_id UUID NOT NULL REFERENCES estimates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  following BOOLEAN,
  last_read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (estimate_id, user_id)
);

CREATE INDEX IF NOT EXISTS order_chat_members_user_idx
  ON order_chat_members (user_id);

ALTER TABLE order_chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_chat_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS order_chat_messages_staff_select ON order_chat_messages;
CREATE POLICY order_chat_messages_staff_select ON order_chat_messages
  FOR SELECT TO authenticated USING (public.is_internal_staff());

DROP POLICY IF EXISTS order_chat_members_own_select ON order_chat_members;
CREATE POLICY order_chat_members_own_select ON order_chat_members
  FOR SELECT TO authenticated USING (user_id = auth.uid());

-- Realtime: an open chat appends new messages as they arrive.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'order_chat_messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE order_chat_messages;
  END IF;
END $$;
