/**
 * Twilio adapter for the SMS provider abstraction.
 *
 * Refactored from src/lib/twilio.ts so the new unified comms path can go
 * through the provider dispatcher. The original src/lib/twilio.ts stays in
 * place for backward compatibility with existing call sites (notify.ts,
 * messages/send-sms route).
 */

import twilio from 'twilio';
import { normalizePhoneNumber, validateTwilioSignature } from '@/lib/twilio';
import type { SmsAttachment, SendSmsResult, InboundMessage, SmsProvider } from './index';

export const name: SmsProvider['name'] = 'twilio';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_PHONE_NUMBER;

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

export async function sendSMS(to: string, body: string): Promise<SendSmsResult> {
  if (!accountSid || !authToken || !fromNumber) {
    return { ok: false, providerName: name, error: 'Twilio credentials/phone not configured' };
  }
  try {
    const message = await getClient().messages.create({
      body,
      from: fromNumber,
      to: normalizePhone(to),
    });
    return { ok: true, sid: message.sid, providerName: name };
  } catch (err: any) {
    return { ok: false, providerName: name, error: err?.message || 'Twilio send failed' };
  }
}

export async function sendMMS(to: string, body: string, attachments: SmsAttachment[]): Promise<SendSmsResult> {
  if (!accountSid || !authToken || !fromNumber) {
    return { ok: false, providerName: name, error: 'Twilio credentials/phone not configured' };
  }
  try {
    const message = await getClient().messages.create({
      body,
      from: fromNumber,
      to: normalizePhone(to),
      mediaUrl: attachments.map(a => a.url),
    });
    return { ok: true, sid: message.sid, providerName: name };
  } catch (err: any) {
    return { ok: false, providerName: name, error: err?.message || 'Twilio MMS send failed' };
  }
}

export function verifyWebhookSignature(url: string, params: Record<string, string>, headers: Record<string, string>): boolean {
  if (process.env.TWILIO_VALIDATE_SIGNATURE !== 'true') return true;
  const sig = headers['x-twilio-signature'] || headers['X-Twilio-Signature'] || '';
  return validateTwilioSignature(url, params, sig);
}

export function parseInbound(form: Record<string, any>): InboundMessage | null {
  const from = form['From'] || form.from;
  const body = form['Body'] || form.body;
  const sid = form['MessageSid'] || form.messageSid || form.sid;
  if (!from || !body) return null;

  const attachments: SmsAttachment[] = [];
  const numMedia = parseInt(form['NumMedia'] || '0', 10);
  for (let i = 0; i < numMedia; i++) {
    const url = form[`MediaUrl${i}`];
    const contentType = form[`MediaContentType${i}`];
    if (url) attachments.push({ url, contentType });
  }

  return {
    from: normalizePhone(from),
    to: form['To'] || undefined,
    body: String(body),
    providerSid: String(sid || ''),
    providerName: name,
    attachments,
    raw: form,
  };
}

export function normalizePhone(phone: string): string {
  return normalizePhoneNumber(phone);
}
