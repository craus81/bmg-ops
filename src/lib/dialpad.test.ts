import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  normalizeDialpadPhone, parseDialpadCall, phoneDigits, verifyDialpadJwt,
} from './dialpad';

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const SECRET = 'shared-secret';
function makeJwt(payload: Record<string, any>, secret = SECRET, alg = 'HS256') {
  const h = b64url(JSON.stringify({ alg, typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}

describe('verifyDialpadJwt', () => {
  it('accepts a correctly signed token and returns its payload', () => {
    const token = makeJwt({ call_id: '123', state: 'ringing' });
    expect(verifyDialpadJwt(token, SECRET)).toMatchObject({ call_id: '123', state: 'ringing' });
  });

  it('rejects a wrong secret, a tampered payload, and a missing secret', () => {
    const token = makeJwt({ call_id: '123' });
    expect(verifyDialpadJwt(token, 'not-the-secret')).toBeNull();
    expect(verifyDialpadJwt(token, undefined)).toBeNull();

    const [h, , s] = token.split('.');
    const forged = `${h}.${b64url(JSON.stringify({ call_id: 'evil' }))}.${s}`;
    expect(verifyDialpadJwt(forged, SECRET)).toBeNull();
  });

  it('refuses alg:none — a token must not talk its way out of being verified', () => {
    const h = b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }));
    const p = b64url(JSON.stringify({ call_id: '123' }));
    expect(verifyDialpadJwt(`${h}.${p}.`, SECRET)).toBeNull();
  });

  it('rejects an expired token and malformed input', () => {
    const expired = makeJwt({ call_id: '1', exp: Math.floor(Date.now() / 1000) - 60 });
    expect(verifyDialpadJwt(expired, SECRET)).toBeNull();
    // Still valid a moment before it lapsed.
    expect(verifyDialpadJwt(expired, SECRET, Date.now() - 120_000)).toMatchObject({ call_id: '1' });
    expect(verifyDialpadJwt('nonsense', SECRET)).toBeNull();
    expect(verifyDialpadJwt('', SECRET)).toBeNull();
  });
});

describe('phone normalization', () => {
  it('keeps the last ten digits for matching', () => {
    expect(phoneDigits('+1 (555) 867-5309')).toBe('5558675309');
    expect(phoneDigits('555.867.5309')).toBe('5558675309');
    expect(phoneDigits(null)).toBe('');
  });

  it('produces E.164 for sending', () => {
    expect(normalizeDialpadPhone('5558675309')).toBe('+15558675309');
    expect(normalizeDialpadPhone('15558675309')).toBe('+15558675309');
    expect(normalizeDialpadPhone('+445558675309')).toBe('+445558675309');
    expect(normalizeDialpadPhone('')).toBe('');
  });
});

describe('parseDialpadCall', () => {
  it('keys on the call id and picks the OTHER party as external', () => {
    const call = parseDialpadCall({
      call_id: 'c1', direction: 'inbound', state: 'ringing',
      external_number: '+15558675309', internal_number: '+15551112222',
      date_started: 1788842400000,
      target: { email: 'rep@bmgfleet.com' },
    })!;
    expect(call).toMatchObject({
      providerCallId: 'c1', direction: 'inbound', externalDigits: '5558675309',
      targetEmail: 'rep@bmgfleet.com',
    });
    expect(call.startedAt).toBe('2026-09-08T04:40:00.000Z');
  });

  it('drops a payload with no call id rather than storing an unkeyable row', () => {
    expect(parseDialpadCall({ state: 'ringing' })).toBeNull();
  });

  it('normalizes duration whether it arrives in seconds or milliseconds', () => {
    expect(parseDialpadCall({ call_id: 'a', duration: 95 })!.durationSeconds).toBe(95);
    expect(parseDialpadCall({ call_id: 'b', duration: 95000 })!.durationSeconds).toBe(95);
  });
});
