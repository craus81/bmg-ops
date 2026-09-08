import { describe, it, expect } from 'vitest';
import { shiftDay, briefWeekBounds, metricDeltas, narrativeFacts, fmtUsd, type OwnerBriefData } from './owner-brief';

describe('shiftDay', () => {
  it('crosses month and year boundaries', () => {
    expect(shiftDay('2026-09-07', -7)).toBe('2026-08-31');
    expect(shiftDay('2026-01-03', -7)).toBe('2025-12-27');
    expect(shiftDay('2026-08-31', 7)).toBe('2026-09-07');
  });
});

describe('briefWeekBounds — the completed week ending the most recent Monday', () => {
  it('run on its Monday schedule, covers the week that just ended', () => {
    // 2026-09-07 is a Monday.
    expect(briefWeekBounds('2026-09-07')).toEqual({ start: '2026-08-31', end: '2026-09-07' });
  });
  it('a manual mid-week or Sunday run re-covers the same completed week', () => {
    expect(briefWeekBounds('2026-09-09')).toEqual({ start: '2026-08-31', end: '2026-09-07' }); // Wednesday
    expect(briefWeekBounds('2026-09-13')).toEqual({ start: '2026-08-31', end: '2026-09-07' }); // Sunday
  });
});

describe('metricDeltas', () => {
  const row = (metric: string, day: string, value: number | null) => ({ metric, day, value });

  it('pairs the latest value with the point ~7 days earlier', () => {
    const out = metricDeltas([
      row('ar_total', '2026-09-01', 1000),
      row('ar_total', '2026-09-08', 1200),
    ], ['ar_total']);
    expect(out.ar_total).toEqual({ now: 1200, nowDay: '2026-09-08', weekAgo: 1000 });
  });

  it('tolerates a missed night (nearest non-null within ±3 days) and skips null-valued rows', () => {
    const out = metricDeltas([
      row('ar_total', '2026-09-01', null), // source errored that night
      row('ar_total', '2026-09-02', 900),
      row('ar_total', '2026-09-08', 1200),
    ], ['ar_total']);
    expect(out.ar_total).toEqual({ now: 1200, nowDay: '2026-09-08', weekAgo: 900 });
  });

  it('a metric captured under a week gets weekAgo null; an uncaptured metric gets all nulls', () => {
    const out = metricDeltas([row('ar_total', '2026-09-08', 1200)], ['ar_total', 'so_unbilled_value']);
    expect(out.ar_total).toEqual({ now: 1200, nowDay: '2026-09-08', weekAgo: null });
    expect(out.so_unbilled_value).toEqual({ now: null, nowDay: null, weekAgo: null });
  });
});

describe('narrativeFacts — the model may see only what gathered cleanly', () => {
  const base: OwnerBriefData = {
    weekStart: '2026-08-31',
    weekEnd: '2026-09-07',
    revenue: { thisWeek: 48210.4, lastWeek: 39050, sameWeekLastYear: 51400 },
    collections: { error: 'RESTlet down' },
    quotes: {
      sentCount: 9, sentValue: 120000, wonCount: 3, wonValue: 41000,
      lostCount: 1, lostValue: 5000, openCount: 5, openValue: 74000,
      winRate: 0.75, avgDaysToClose: 2.5,
    },
    shipped: { vehicles: 12, customers: 5 },
    promises: { kept: 7, missed: 2, overdueNow: 3 },
    deltas: {
      ar_total: { now: 250000, nowDay: '2026-09-07', weekAgo: 240000 },
      so_order_book_value: { now: null, nowDay: null, weekAgo: null },
    },
    exceptions: { total: 4, top: [{ label: 'vehicle status forced past a gate', count: 2 }] },
  };

  it('emits a line per healthy section and none for errored/empty ones', () => {
    const facts = narrativeFacts(base);
    expect(facts.join('\n')).toContain('$48,210');
    expect(facts.join('\n')).toContain('12 for 5 customers');
    expect(facts.join('\n')).toContain('7 kept, 2 missed');
    expect(facts.join('\n')).toContain('$250,000');
    expect(facts.join('\n')).toContain('Guard overrides recorded this week: 4');
    expect(facts.join('\n')).not.toContain('payments collected'); // collections errored
    expect(facts.join('\n')).not.toContain('sales-order book'); // no snapshot yet
  });
});

describe('fmtUsd', () => {
  it('whole dollars with separators; sign preserved', () => {
    expect(fmtUsd(48210.4)).toBe('$48,210');
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(-1234.5)).toBe('−$1,235');
  });
});
