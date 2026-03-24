-- Add url column to notifications for deep linking
-- Run in Supabase SQL Editor

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS url TEXT DEFAULT NULL;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'notifications'
ORDER BY ordinal_position;
