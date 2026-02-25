-- Add read_at column to notifications for read/unread tracking
-- Run in Supabase SQL Editor

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamptz DEFAULT NULL;

-- Add index for fast unread count queries
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
ON notifications (user_id, read_at) WHERE read_at IS NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'notifications'
ORDER BY ordinal_position;
