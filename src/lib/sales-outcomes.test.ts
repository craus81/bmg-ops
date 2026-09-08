import { describe, it, expect } from 'vitest';
import { summarizeOutcomes, normalizeLeadSource, type OutcomeRow } from './sales-outcomes';

describe('summarizeOutcomes', () => {
  const row = (outcome: OutcomeRow['outcome'], sentAt: string, decidedAt: string | null, reminders = 0, channel: string | null = null): OutcomeRow =>
    ({ sentAt, outcome, decidedAt, reminders, channel });

  it('counts outcomes, median time-to-decision, reminder histogram, channel split', () => {
    const s = summarizeOutcomes([
      row('approved', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', 0, 'email_link'), // 2d
      row('approved', '2026-09-01T00:00:00Z', '2026-09-07T00:00:00Z', 2, 'sms_link'), // 6d
      row('rejected', '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', 1), // 4d
      row('pending', '2026-09-01T00:00:00Z', null, 3),
    ]);
    expect(s).toMatchObject({ sent: 4, approved: 2, rejected: 1, pending: 1, medianDaysToDecision: 4 });
    // Histogram counts APPROVALS only — the pending row's 3 reminders don't land in threePlus.
    expect(s.remindersAtApproval).toEqual({ none: 1, one: 0, two: 1, threePlus: 0 });
    expect(s.channels).toEqual({ email: 1, sms: 1 });
  });

  it('handles no decisions (median null) and drops negative spans', () => {
    const s = summarizeOutcomes([
      row('pending', '2026-09-01T00:00:00Z', null),
      row('approved', '2026-09-05T00:00:00Z', '2026-09-01T00:00:00Z'), // bad data: negative span
    ]);
    expect(s.medianDaysToDecision).toBe(null);
    expect(s.approved).toBe(1);
  });
});

describe('normalizeLeadSource', () => {
  it('lowercases, trims, resolves "other", and names the blank bucket', () => {
    expect(normalizeLeadSource(' Referral ', null)).toBe('referral');
    expect(normalizeLeadSource('other', ' Chamber Mixer ')).toBe('chamber mixer');
    expect(normalizeLeadSource('other', '')).toBe('other');
    expect(normalizeLeadSource(null, null)).toBe('(not recorded)');
    expect(normalizeLeadSource('', 'ignored')).toBe('(not recorded)');
  });
});
