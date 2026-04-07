-- Migration: Add notify_new_po preference to notification_preferences
ALTER TABLE notification_preferences
ADD COLUMN IF NOT EXISTS notify_new_po BOOLEAN NOT NULL DEFAULT false;
