import { describe, it, expect } from 'vitest';
import { shopMidnight, weekWindows, countByWeek } from './my-week';

describe('shopMidnight', () => {
  it('is 05:00Z during CDT and 06:00Z during CST', () => {
    expect(shopMidnight('2026-09-28').toISOString()).toBe('2026-09-28T05:00:00.000Z');
    expect(shopMidnight('2026-12-07').toISOString()).toBe('2026-12-07T06:00:00.000Z');
  });

  it('handles the DST change days', () => {
    expect(shopMidnight('2026-03-08').toISOString()).toBe('2026-03-08T06:00:00.000Z');
    expect(shopMidnight('2026-11-01').toISOString()).toBe('2026-11-01T05:00:00.000Z');
  });
});

describe('weekWindows', () => {
  it('starts on the shop Monday, even late Sunday night UTC-wise', () => {
    // 2026-09-29T03:00Z is still Monday 9/28 evening in Chicago.
    const w = weekWindows(new Date('2026-09-29T03:00:00Z'));
    expect(w.today).toBe('2026-09-28');
    expect(w.weekStart).toBe('2026-09-28');
    expect(w.thisStart.toISOString()).toBe('2026-09-28T05:00:00.000Z');
    expect(w.lastStart.toISOString()).toBe('2026-09-21T05:00:00.000Z');
    expect(w.lastEnd.toISOString()).toBe('2026-09-22T03:00:00.000Z');
  });

  it('a Sunday belongs to the week that began the Monday before', () => {
    expect(weekWindows(new Date('2026-10-04T18:00:00Z')).weekStart).toBe('2026-09-28');
  });
});

describe('countByWeek', () => {
  const w = weekWindows(new Date('2026-09-30T20:00:00Z')); // Wed afternoon
  const rows = [
    { at: '2026-09-28T14:00:00Z', vin: 'A' },
    { at: '2026-09-29T14:00:00Z', vin: 'A' },
    { at: '2026-09-30T14:00:00Z', vin: 'B' },
    { at: '2026-09-22T14:00:00Z', vin: 'C' },
    { at: '2026-09-24T14:00:00Z', vin: 'D' }, // last Thu: past the like-for-like cutoff
    { at: '2026-09-20T14:00:00Z', vin: 'E' }, // two Sundays ago
    { at: null, vin: 'F' },
  ];

  it('counts every row without a key', () => {
    expect(countByWeek(rows, r => r.at, w)).toEqual({ thisWeek: 3, lastWeek: 1 });
  });

  it('dedupes by key', () => {
    expect(countByWeek(rows, r => r.at, w, r => r.vin)).toEqual({ thisWeek: 2, lastWeek: 1 });
  });
});
