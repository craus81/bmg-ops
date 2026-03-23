import twilio from 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER; // Your Twilio phone number e.g. +15551234567

let _client: ReturnType<typeof twilio> | null = null;

function getClient() {
  if (!_client) {
    if (!accountSid || !authToken) {
      throw new Error('Twilio credentials not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)');
    }
    _client = twilio(accountSid, authToken);
  }
  return _client;
}

/**
 * Send an SMS message via Twilio
 * Returns the message SID if successful, null if Twilio is not configured
 */
export async function sendSMS(to: string, body: string): Promise<string | null> {
  if (!accountSid || !authToken || !fromNumber) {
    console.warn('Twilio not configured — skipping SMS send');
    return null;
  }

  try {
    const client = getClient();
    const message = await client.messages.create({
      body,
      from: fromNumber,
      to: normalizePhoneNumber(to),
    });
    return message.sid;
  } catch (err) {
    console.error('Twilio SMS send failed:', err);
    return null;
  }
}

/**
 * Normalize a phone number to E.164 format
 * Handles common US formats like (555) 123-4567, 555-123-4567, etc.
 */
export function normalizePhoneNumber(phone: string): string {
  // Strip everything except digits and leading +
  const digits = phone.replace(/[^\d+]/g, '');

  // If it already starts with +, assume E.164
  if (digits.startsWith('+')) return digits;

  // If 10 digits, assume US number
  if (digits.length === 10) return `+1${digits}`;

  // If 11 digits starting with 1, assume US with country code
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;

  // Otherwise just prepend + and hope for the best
  return `+${digits}`;
}

/**
 * Validate Twilio webhook signature for security
 */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string
): boolean {
  if (!authToken) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}
