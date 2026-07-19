-- @Mentions in notes: tag a teammate in any note (vehicle, graphics job,
-- upfit project, PO) and it lands in their Mentions inbox with a push —
-- one place to see everything you've been tagged in.

CREATE TABLE IF NOT EXISTS note_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentioned_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mentioned_by UUID REFERENCES profiles(id),
  -- Where the note lives: 'vehicle_note' | 'graphics_note' | 'upfit_note'
  -- | 'po_note' (free text so new surfaces don't need a migration).
  source_type TEXT NOT NULL,
  source_id UUID,
  context_label TEXT,
  context_url TEXT,
  note_excerpt TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_mentions_user
  ON note_mentions(mentioned_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_note_mentions_unread
  ON note_mentions(mentioned_user_id) WHERE read_at IS NULL;

ALTER TABLE note_mentions ENABLE ROW LEVEL SECURITY;
-- Inserts happen through the API (service role). Users see and mark-read
-- only their own mentions.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can view own mentions' AND tablename = 'note_mentions') THEN
    CREATE POLICY "Users can view own mentions" ON note_mentions
      FOR SELECT TO authenticated USING (mentioned_user_id = auth.uid());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can mark own mentions read' AND tablename = 'note_mentions') THEN
    CREATE POLICY "Users can mark own mentions read" ON note_mentions
      FOR UPDATE TO authenticated USING (mentioned_user_id = auth.uid()) WITH CHECK (mentioned_user_id = auth.uid());
  END IF;
END $$;
