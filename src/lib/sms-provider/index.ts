/**
 * SMS provider abstraction
 *
 * Dispatches outbound SMS/MMS through the configured provider (Twilio or
 * RingCentral), and gives webhook routes a single place to parse inbound
 * payloads without caring which provider they came from.
 *
 * Runtime gating:
 * - SMS_PROVIDER_ENABLED=true must be set to actually dispatch SMS/MMS.
 *   When false (default), send* calls return { ok: false, skipped: true }.
 *   Email paths are unaffected — they're wired elsewhere in notify.ts.
 * - SMS_PROVIDER selects the active adapter. Values: 'ringcentral' |
 *   'twilio'. Default 'twilio' since it has working credentials plumbing.
 *   RingCentral lights up once T1.5's operational track completes.
 */

import * as twilioAdapter from './twilio';
import * as ringcentralAdapter from './ringcentral';

export type SmsAttachment = {
  url: string;
  contentType?: string;
};

export type SendSmsResult = {
  ok: boolean;
  sid?: string;
  providerName: string;
  skipped?: boolean;
  error?: string;
};

export type InboundMessage = {
  from: string;
  to?: string;
  body: string;
  providerSid: string;
  providerName: string;
  attachments?: SmsAttachment[];
  raw?: Record<string, any>;
};

export interface SmsProvider {
  name: 'twilio' | 'ringcentral';
  sendSMS(to: string, body: string): Promise<SendSmsResult>;
  sendMMS(to: string, body: string, attachments: SmsAttachment[]): Promise<SendSmsResult>;
  verifyWebhookSignature(url: string, params: Record<string, string>, headers: Record<string, string>): boolean;
  parseInbound(formLike: Record<string, any>): InboundMessage | null;
  normalizePhone(phone: string): string;
}

function isEnabled(): boolean {
  return process.env.SMS_PROVIDER_ENABLED === 'true';
}

function active(): SmsProvider {
  const choice = (process.env.SMS_PROVIDER || 'twilio').toLowerCase();
  if (choice === 'ringcentral') return ringcentralAdapter as SmsProvider;
  return twilioAdapter as SmsProvider;
}

/**
 * Dispatch an outbound SMS. Returns { ok:false, skipped:true } when the
 * provider flag is off so callers can log-and-continue rather than fail.
 */
export async function sendSMS(to: string, body: string): Promise<SendSmsResult> {
  const provider = active();
  if (!isEnabled()) {
    return { ok: false, skipped: true, providerName: provider.name };
  }
  return provider.sendSMS(to, body);
}

/**
 * Dispatch an outbound MMS with 1-N attachments.
 */
export async function sendMMS(to: string, body: string, attachments: SmsAttachment[]): Promise<SendSmsResult> {
  const provider = active();
  if (!isEnabled()) {
    return { ok: false, skipped: true, providerName: provider.name };
  }
  return provider.sendMMS(to, body, attachments);
}

export function getActiveProviderName(): string {
  return active().name;
}

export function verifyWebhookSignature(url: string, params: Record<string, string>, headers: Record<string, string>): boolean {
  return active().verifyWebhookSignature(url, params, headers);
}

export function parseInbound(formLike: Record<string, any>): InboundMessage | null {
  return active().parseInbound(formLike);
}

export function normalizePhone(phone: string): string {
  return active().normalizePhone(phone);
}
