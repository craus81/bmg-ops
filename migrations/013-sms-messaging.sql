-- Migration 013: SMS messaging integration
-- Adds SMS-for-messages preference and Twilio tracking fields

-- Add messaging-specific notification preferences (separate from graphics notification prefs)
ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS sms_messages boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_messages_mode text DEFAULT 'always' CHECK (sms_messages_mode IN ('always', 'unread_only')),
  ADD COLUMN IF NOT EXISTS email_messages boolean DEFAULT false;

-- Track which messages were sent via SMS (for deduplication on inbound replies)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS via_sms boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_sid text;

-- Store Twilio phone number mapping for inbound routing
-- When an SMS comes in, we need to know which user sent it
-- We store a normalized phone number on profiles for matching
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone_number text;
