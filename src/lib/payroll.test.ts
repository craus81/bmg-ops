import { describe, it, expect } from 'vitest';
import { periodForDate, periodAt, shiftPeriod, toDateString } from './payroll';

describe('payroll periods (biweekly, anchored 2026-06-15)', () => {
  it('anchor day starts period 0', () => {
    const p = periodForDate(new Date(2026, 5, 15));
    expect(toDateString(p.start)).toBe('2026-06-15');
    expect(toDateString(p.end)).toBe('2026-06-28');
    expect(toDateString(p.endExclusive)).toBe('2026-06-29');
  });

  it('last day of a period still belongs to it', () => {
    const p = periodForDate(new Date(2026, 5, 28, 23, 59));
    expect(toDateString(p.start)).toBe('2026-06-15');
  });

  it('next day rolls into the following period', () => {
    const p = periodForDate(new Date(2026, 5, 29));
    expect(toDateString(p.start)).toBe('2026-06-29');
    expect(toDateString(p.end)).toBe('2026-07-12');
  });

  it('dates before the anchor fall into earlier periods on the same grid', () => {
    const p = periodForDate(new Date(2026, 5, 12)); // 6/12/26 — three days before anchor
    expect(toDateString(p.start)).toBe('2026-06-01');
    expect(toDateString(p.end)).toBe('2026-06-14');
  });

  it('periodAt and shiftPeriod agree', () => {
    const p0 = periodAt(0);
    expect(toDateString(shiftPeriod(p0, 1).start)).toBe('2026-06-29');
    expect(toDateString(shiftPeriod(p0, -1).start)).toBe('2026-06-01');
    expect(toDateString(shiftPeriod(shiftPeriod(p0, 5), -5).start)).toBe('2026-06-15');
  });

  it('stays aligned across DST boundaries', () => {
    // November 2026 crosses the US DST fall-back; periods must stay 14 days.
    const p = periodForDate(new Date(2026, 10, 2));
    const next = shiftPeriod(p, 1);
    const dayDiff = Math.round((next.start.getTime() - p.start.getTime()) / (24 * 60 * 60 * 1000));
    expect(dayDiff).toBe(14);
  });
});
