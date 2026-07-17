-- Invoicing notifications become opt-in.
--
-- The invoice prompts ("Graphics shipped — create invoice?") and the
-- invoice-created pings go to approved admins, but each admin must opt in
-- via Settings rather than being enrolled automatically.

ALTER TABLE notification_preferences
  ADD COLUMN IF NOT EXISTS notify_invoicing BOOLEAN DEFAULT false;

COMMENT ON COLUMN notification_preferences.notify_invoicing IS
  'Opt-in: invoice prompts (shipped job needs an invoice) and invoice-created notifications. Only approved admins receive these regardless of the flag.';

-- The two users who were hardcoded recipients before the opt-in existed
-- stay opted in — otherwise this migration would silently stop the
-- notifications they rely on.
INSERT INTO notification_preferences (user_id, notify_invoicing)
SELECT id, true FROM auth.users
WHERE id IN (
  'f9f8a88c-1049-4bd5-95db-888787677ac9', -- Craig George
  '13c993b2-bb84-4539-8bbc-6c85395f558c'  -- Jessie Whittington
)
ON CONFLICT (user_id) DO UPDATE SET notify_invoicing = true;
