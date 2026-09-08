import crypto from 'crypto';

/**
 * Dialpad integration primitives (R6-3).
 *
 * Dialpad delivers Event Subscription payloads as a JWT signed (HS256)
 * with a shared secret YOU supply when creating the subscription — so
 * verification is an HMAC we can do with node crypto, no new dependency.
 * Everything here is pure and tested; the route and the SMS adapter just
 * call it.
 *
 * Security posture matches the Twilio adapter: verification is ON by
 * default and a missing secret REJECTS. A webhook that writes CRM rows and
 * fires notifications must never fail open — that was the exact bug the
 * Twilio adapter's comment records.
 */

/** Digits only, last 10 kept — how the app's phone_digits columns match. */
export function phoneDigits(phone: string | null | undefined): string {
  const d = String(phone || '').replace(/\D+/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

/** E.164-ish for outbound sends; US default when no country code given. */
export function normalizeDialpadPhone(phone: string): string {
  const raw = String(phone || '').trim();
  if (raw.startsWith('+')) return '+' + raw.slice(1).replace(/\D+/g, '');
  const d = raw.replace(/\D+/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return d ? `+${d}` : '';
}

const b64urlToBuf = (s: string) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Verify a Dialpad HS256 JWT and return its payload, or null when the
 * token is malformed, wrongly signed, or expired. Signature comparison is
 * timing-safe.
 */
export function verifyDialpadJwt(token: string, secret: string | undefined, nowMs = Date.now()): Record<string, any> | null {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: any;
  try {
    header = JSON.parse(b64urlToBuf(headerB64).toString('utf8'));
  } catch { return null; }
  // Reject alg:none and anything we don't actually verify — the classic
  // JWT forgery is a token that asks to be trusted unsigned.
  if (!header || header.alg !== 'HS256') return null;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const given = b64urlToBuf(sigB64);
  if (given.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(given, expected)) return null;

  let payload: any;
  try {
    payload = JSON.parse(b64urlToBuf(payloadB64).toString('utf8'));
  } catch { return null; }
  if (payload?.exp && typeof payload.exp === 'number' && payload.exp * 1000 < nowMs) return null;
  return payload;
}

export interface DialpadCall {
  providerCallId: string;
  direction: 'inbound' | 'outbound';
  state: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  /** The other party's digits — whichever end isn't us. */
  externalDigits: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  targetEmail: string | null;
}

const iso = (v: any): string | null => {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  // Dialpad sends epoch milliseconds on call events.
  if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Normalize a Dialpad call event into the row we store. Returns null when
 * the payload carries no call id — anything we cannot key on, we drop
 * rather than insert a row we can never update.
 */
export function parseDialpadCall(payload: Record<string, any>): DialpadCall | null {
  const providerCallId = String(payload.call_id ?? payload.id ?? '').trim();
  if (!providerCallId) return null;

  const direction: 'inbound' | 'outbound' = payload.direction === 'outbound' ? 'outbound' : 'inbound';
  const fromNumber = payload.external_number && direction === 'inbound'
    ? String(payload.external_number)
    : payload.from_number ? String(payload.from_number) : null;
  const toNumber = payload.internal_number
    ? String(payload.internal_number)
    : payload.to_number ? String(payload.to_number) : null;

  // The party we care about is whoever isn't BMG: on an inbound call the
  // caller, on an outbound call the person dialed.
  const external = payload.external_number
    ? String(payload.external_number)
    : direction === 'inbound' ? fromNumber : toNumber;

  // Dialpad sends call duration in milliseconds, but be defensive: anything
  // over ~2.8 hours is far likelier to be a millisecond count than a real
  // call length, so that is the seconds/ms boundary. (A 95000 value is 95
  // seconds, not 26 hours.)
  const MS_THRESHOLD_SECONDS = 10_000;
  const durationRaw = payload.duration ?? payload.total_duration ?? null;
  const duration = durationRaw == null
    ? null
    : Math.round(Number(durationRaw) / (Number(durationRaw) > MS_THRESHOLD_SECONDS ? 1000 : 1));

  return {
    providerCallId,
    direction,
    state: payload.state ? String(payload.state) : null,
    fromNumber,
    toNumber,
    externalDigits: phoneDigits(external),
    startedAt: iso(payload.date_started ?? payload.date_connected ?? payload.started),
    endedAt: iso(payload.date_ended ?? payload.ended),
    durationSeconds: Number.isFinite(duration as number) ? (duration as number) : null,
    targetEmail: payload.target?.email ? String(payload.target.email)
      : payload.operator?.email ? String(payload.operator.email) : null,
  };
}

/** Call states worth interrupting a human for. */
export const RINGING_STATES = new Set(['ringing', 'calling', 'connected']);
export const FINISHED_STATES = new Set(['hangup', 'ended', 'completed', 'missed', 'voicemail']);
