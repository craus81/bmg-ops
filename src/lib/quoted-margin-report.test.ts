import { describe, it, expect } from 'vitest';
import { weightedMarginPct, classifyVsFloor, summarizeQuotedMargins, type FrozenQuoteRow } from './quoted-margin-report';

const row = (over: Partial<FrozenQuoteRow>): FrozenQuoteRow => ({
  id: 'e1', number: 'EST-1', customer: 'Acme', total: 1000, costTotal: 600,
  marginPct: 40, belowFloor: false, floorPct: 30, reason: null,
  frozenAt: '2026-09-01T10:00:00Z', senderId: 'u1', status: 'sent',
  ...over,
});

describe('weightedMarginPct', () => {
  it('value-weights and skips unknown margins and zero totals', () => {
    expect(weightedMarginPct([
      { marginPct: 40, total: 1000 },
      { marginPct: 20, total: 3000 },
      { marginPct: null, total: 5000 }, // unknown — excluded, never 100%
      { marginPct: 90, total: 0 },
    ])).toBe(25); // (40×1000 + 20×3000) / 4000
    expect(weightedMarginPct([{ marginPct: null, total: 100 }])).toBe(null);
  });
});

describe('classifyVsFloor', () => {
  it('buckets against the floor frozen with the row', () => {
    expect(classifyVsFloor(29.9, 30)).toBe('below');
    expect(classifyVsFloor(30, 30)).toBe('floor0_10');
    expect(classifyVsFloor(40, 30)).toBe('floor10_20');
    expect(classifyVsFloor(55, 30)).toBe('floor20p');
    expect(classifyVsFloor(null, 30)).toBe('unknown');
    expect(classifyVsFloor(40, null)).toBe('unknown');
  });
});

describe('summarizeQuotedMargins', () => {
  it('rolls up totals, groups, distribution, and the below-floor list', () => {
    const s = summarizeQuotedMargins([
      row({ id: 'a', total: 1000, marginPct: 40, senderId: 'u1', frozenAt: '2026-08-15T00:00:00Z' }),
      row({ id: 'b', total: 2000, marginPct: 25, belowFloor: true, reason: 'strategic account', senderId: 'u2', customer: 'Beta', frozenAt: '2026-09-02T00:00:00Z' }),
      row({ id: 'c', total: 500, marginPct: null, costTotal: null, senderId: 'u1', frozenAt: '2026-09-03T00:00:00Z' }),
    ]);
    expect(s.totals).toMatchObject({ count: 3, value: 3500, belowFloor: 1, belowFloorValue: 2000, unknownMargin: 1 });
    expect(s.totals.weightedMarginPct).toBe(30); // (40×1000 + 25×2000) / 3000
    expect(s.byRep[0]).toMatchObject({ senderId: 'u2', value: 2000 });
    expect(s.byMonth.map(m => m.month)).toEqual(['2026-08', '2026-09']);
    expect(s.distribution.below).toEqual({ count: 1, value: 2000 });
    expect(s.distribution.floor10_20).toEqual({ count: 1, value: 1000 });
    expect(s.distribution.unknown.count).toBe(1);
    expect(s.belowFloorList.map(r => r.id)).toEqual(['b']);
  });
});
