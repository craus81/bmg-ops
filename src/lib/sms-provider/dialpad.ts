/**
 * Dialpad adapter for the SMS provider abstraction (R6-3).
 *
 * Third provider behind the same interface as Twilio and the RingCentral
 * stub, so adopting it is an env flip rather than a rewrite of every send
 * site:
 *     DIALPAD_API_KEY=...            (Admin > Company Settings > API keys)
 *     DIALPAD_FROM_NUMBER=+1NXXNXXXXXX   (or DIALPAD_USER_ID to send as a user)
 *     DIALPAD_WEBHOOK_SECRET=...     (the shared secret you set when creating
 *                                     the Event Subscription — Dialpad signs
 *                                     every delivery as an HS256 JWT with it)
 *     SMS_PROVIDER=dialpad
 *     SMS_PROVIDER_ENABLED=true
 *
 * Inbound webhook URL to register with the subscription:
 *     POST {APP_URL}/api/webhooks/dialpad
 */

import { normalizeDialpadPhone, phoneDigits, verifyDialpadJwt } from '@/lib/dialpad';
import type { SmsAttachment, SendSmsResult, InboundMessage, SmsProvider } from './index';

export const name = 'dialpad' as unknown as SmsProvider['name'];

const API_BASE = 'https://dialpad.com/api/v2';
const apiKey = () => process.env.DIALPAD_API_KEY;
const fromNumber = () => process.env.DIALPAD_FROM_NUMBER;
const userId = () => process.env.DIALPAD_USER_ID;

async function post(path: string, body: Record<string, unknown>): Promise<SendSmsResult> {
  const key = apiKey();
  if (!key || (!fromNumber() && !userId())) {
    return { ok: false, providerName: 'dialpad', error: 'Dialpad not configured (DIALPAD_API_KEY + DIALPAD_FROM_NUMBER or DIALPAD_USER_ID)' };
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, providerName: 'dialpad', error: json?.error?.message || `Dialpad HTTP ${res.status}` };
    }
    return { ok: true, sid: String(json?.id ?? json?.message_id ?? ''), providerName: 'dialpad' };
  } catch (err: any) {
    return { ok: false, providerName: 'dialpad', error: err?.message || 'Dialpad send failed' };
  }
}

function sendPayload(to: string, text: string) {
  const payload: Record<string, unknown> = { to_numbers: [normalizeDialpadPhone(to)], text };
  // Sending as a user threads the reply into that person's Dialpad inbox;
  // sending from a number puts it on the main line.
  if (userId()) payload.user_id = userId();
  else payload.from_number = normalizeDialpadPhone(fromNumber()!);
  return payload;
}

export async function sendSMS(to: string, body: string): Promise<SendSmsResult> {
  return post('/sms', sendPayload(to, body));
}

export async function sendMMS(to: string, body: string, attachments: SmsAttachment[]): Promise<SendSmsResult> {
  return post('/sms', { ...sendPayload(to, body), media: attachments.map(a => a.url) });
}

/**
 * Dialpad signs deliveries as an HS256 JWT rather than a header HMAC over
 * the URL, so the token is the payload. Secure by default like the Twilio
 * adapter: no secret configured means REJECT, never fail open — this
 * webhook writes CRM rows and fires notifications.
 */
export function verifyWebhookSignature(_url: string, params: Record<string, string>, headers: Record<string, string>): boolean {
  const token = params.__jwt
    || headers['x-dialpad-signature']
    || (headers.authorization || '').replace(/^Bearer\s+/i, '');
  return verifyDialpadJwt(token, process.env.DIALPAD_WEBHOOK_SECRET) != null;
}

export function parseInbound(payload: Record<string, any>): InboundMessage | null {
  const from = payload.from_number || payload.from;
  const body = payload.text ?? payload.body;
  const id = payload.id ?? payload.message_id;
  if (!from || body == null) return null;

  const media = Array.isArray(payload.media) ? payload.media : [];
  return {
    from: normalizePhone(String(from)),
    to: payload.to_number ? String(payload.to_number) : Array.isArray(payload.to_numbers) ? String(payload.to_numbers[0]) : undefined,
    body: String(body),
    providerSid: String(id || ''),
    providerName: 'dialpad',
    attachments: media
      .map((m: any) => (typeof m === 'string' ? { url: m } : { url: m?.url, contentType: m?.content_type }))
      .filter((a: SmsAttachment) => !!a.url),
    raw: payload,
  };
}

export function normalizePhone(phone: string): string {
  return normalizeDialpadPhone(phone);
}

/** Digits-only form used to match a caller against CRM phone columns. */
export { phoneDigits };
