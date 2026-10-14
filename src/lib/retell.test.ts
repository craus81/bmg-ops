import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import {
  afterHoursCallSubject, buildAfterHoursCallEmail, parseRetellCall, prettyPhone, verifyRetellSignature,
} from './retell';

const KEY = 'key_test';
const sign = (body: string, ts: number, key = KEY) =>
  `v=${ts},d=${crypto.createHmac('sha256', key).update(body + ts).digest('hex')}`;

const sample = {
  event: 'call_analyzed',
  call: {
    call_id: 'call_abc',
    direction: 'inbound',
    from_number: '+16365550142',
    to_number: '+16365550100',
    start_timestamp: Date.parse('2026-10-14T23:12:00Z'),
    end_timestamp: Date.parse('2026-10-14T23:14:05Z'),
    duration_ms: 125000,
    transcript: 'Agent: Thanks for calling BMG Fleet.\nUser: Hi, I need racks on 3 Transits <b>asap</b>.',
    recording_url: 'https://example.com/rec.wav',
    call_analysis: {
      call_summary: 'Dana from Acme Plumbing wants ladder racks on three Ford Transits.',
      custom_analysis_data: {
        caller_name: 'Dana Smith', company: 'Acme Plumbing', callback_number: '636-555-0199',
        email: 'dana@acme.test', reason: 'quote', reference: 'N/A', urgent: 'no',
      },
    },
  },
};

describe('verifyRetellSignature', () => {
  const body = JSON.stringify(sample);
  const now = 1_760_000_000_000;

  it('accepts a correct signature within five minutes', () => {
    expect(verifyRetellSignature(body, sign(body, now - 60_000), KEY, now)).toBe(true);
  });

  it('rejects a wrong key, a tampered body, a stale stamp and a missing key', () => {
    const sig = sign(body, now);
    expect(verifyRetellSignature(body, sig, 'other', now)).toBe(false);
    expect(verifyRetellSignature(body + ' ', sig, KEY, now)).toBe(false);
    expect(verifyRetellSignature(body, sign(body, now - 6 * 60_000), KEY, now)).toBe(false);
    expect(verifyRetellSignature(body, sig, undefined, now)).toBe(false);
    expect(verifyRetellSignature(body, null, KEY, now)).toBe(false);
    expect(verifyRetellSignature(body, 'garbage', KEY, now)).toBe(false);
  });
});

describe('parseRetellCall', () => {
  it('pulls the agent fields and drops placeholder values', () => {
    const c = parseRetellCall(sample)!;
    expect(c).toMatchObject({
      callId: 'call_abc', direction: 'inbound', externalDigits: '6365550142',
      callerName: 'Dana Smith', callerCompany: 'Acme Plumbing', callbackNumber: '636-555-0199',
      reason: 'quote', reference: null, urgent: false, durationSeconds: 125,
    });
    expect(c.startedAt).toBe('2026-10-14T23:12:00.000Z');
  });

  it('falls back to caller ID for the callback number and reads urgent', () => {
    const c = parseRetellCall({
      call: { call_id: 'x', from_number: '+16365550142', call_analysis: { custom_analysis_data: { urgent: true } } },
    })!;
    expect(c.callbackNumber).toBe('+16365550142');
    expect(c.urgent).toBe(true);
  });

  it('returns null without a call id', () => {
    expect(parseRetellCall({ event: 'call_analyzed', call: {} })).toBeNull();
  });
});

describe('after-hours call email', () => {
  it('names the caller and reason in the subject, URGENT first when flagged', () => {
    const c = parseRetellCall(sample)!;
    expect(afterHoursCallSubject(c)).toBe('After-hours call: Dana Smith, Acme Plumbing · Quote request');
    expect(afterHoursCallSubject({ ...c, urgent: true, callerName: null, callerCompany: null }))
      .toBe('URGENT · After-hours call: (636) 555-0199 · Quote request');
  });

  it('escapes caller text and links call-back, record and recording', () => {
    const html = buildAfterHoursCallEmail(parseRetellCall(sample)!, 'https://go.bmgfleet.com/admin/prospects/p1');
    expect(html).toContain('&lt;b&gt;asap&lt;/b&gt;');
    expect(html).not.toContain('<b>asap</b>');
    expect(html).toContain('href="tel:6365550199"');
    expect(html).toContain('https://go.bmgfleet.com/admin/prospects/p1');
    expect(html).toContain('Open the call');
    expect(html).toContain('https://example.com/rec.wav');
    expect(html).toContain('Caller:</span>');
    expect(html).toContain('Wed, Oct 14, 6:12 PM');
  });

  it('lists who the email went to', () => {
    const html = buildAfterHoursCallEmail(parseRetellCall(sample)!, 'https://x', ['Craig George', 'Jessie Doe']);
    expect(html).toContain('Sent to Craig George, Jessie Doe.');
  });

  it('formats US numbers', () => {
    expect(prettyPhone('+1 636 555 0142')).toBe('(636) 555-0142');
  });
});
