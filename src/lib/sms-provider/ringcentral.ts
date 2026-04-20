/**
 * RingCentral adapter — STUB until credentials are provisioned.
 *
 * Activation steps when BMG's RingCentral onboarding completes:
 *   1. Acquire Standard+ plan (Essentials excludes SMS API)
 *   2. Complete A2P 10DLC brand + campaign registration
 *   3. Provision Client ID / Secret / JWT or OAuth refresh token
 *   4. Populate env:
 *        RC_SERVER_URL=https://platform.ringcentral.com
 *        RC_CLIENT_ID=...
 *        RC_CLIENT_SECRET=...
 *        RC_JWT=...  (or OAuth refresh token)
 *        RC_FROM_NUMBER=+1NXXNXXXXXX
 *   5. Flip env SMS_PROVIDER=ringcentral (default today is twilio)
 *   6. Flip env SMS_PROVIDER_ENABLED=true
 *
 * Until then these methods return a clean "not implemented" result so
 * the dispatcher can fall back gracefully. Inbound webhook URL (once
 * configured in RC admin):
 *     POST {APP_URL}/api/messages/sms-webhook
 */

import type { SmsAttachment, SendSmsResult, InboundMessage, SmsProvider } from './index';

export const name: SmsProvider['name'] = 'ringcentral';

export async function sendSMS(_to: string, _body: string): Promise<SendSmsResult> {
  return {
    ok: false,
    providerName: name,
    error: 'RingCentral adapter not yet implemented — waiting on provisioning',
  };
}

export async function sendMMS(_to: string, _body: string, _attachments: SmsAttachment[]): Promise<SendSmsResult> {
  return {
    ok: false,
    providerName: name,
    error: 'RingCentral adapter not yet implemented — waiting on provisioning',
  };
}

export function verifyWebhookSignature(_url: string, _params: Record<string, string>, _headers: Record<string, string>): boolean {
  // Until credentials are provisioned, reject anything claiming to be from RC
  return false;
}

export function parseInbound(_form: Record<string, any>): InboundMessage | null {
  // RingCentral posts JSON payloads; wire once credentials land
  return null;
}

export function normalizePhone(phone: string): string {
  // Simple E.164 best-effort — matches the Twilio adapter for now
  const digits = phone.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}
