import { describe, it, expect } from 'vitest';
import { revenuePeriodBounds } from './revenue-summary';

describe('revenuePeriodBounds — CEO revenue period boundaries', () => {
  it('mid-quarter day', () => {
    const b = revenuePeriodBounds('2026-09-07');
    expect(b.monthStart).toBe('2026-09-01');
    expect(b.lastMonthStart).toBe('2026-08-01');
    expect(b.lastMonthSameDay).toBe('2026-08-07');
    expect(b.quarterStart).toBe('2026-07-01');
    expect(b.yearStart).toBe('2026-01-01');
    expect(b.trailing12Start).toBe('2025-10-01');
    expect(b.chartStart).toBe('2025-09-01');
  });

  it('January rolls the prior month and chart into last year', () => {
    const b = revenuePeriodBounds('2026-01-15');
    expect(b.lastMonthStart).toBe('2025-12-01');
    expect(b.lastMonthSameDay).toBe('2025-12-15');
    expect(b.quarterStart).toBe('2026-01-01');
    expect(b.trailing12Start).toBe('2025-02-01');
    expect(b.chartStart).toBe('2025-01-01');
  });

  it('clamps the same-day comparison for short months', () => {
    expect(revenuePeriodBounds('2026-03-31').lastMonthSameDay).toBe('2026-02-28');
    expect(revenuePeriodBounds('2028-03-31').lastMonthSameDay).toBe('2028-02-29'); // leap year
    expect(revenuePeriodBounds('2026-07-31').lastMonthSameDay).toBe('2026-06-30');
  });

  it('December quarter and trailing-12 stay inside the year', () => {
    const b = revenuePeriodBounds('2026-12-10');
    expect(b.quarterStart).toBe('2026-10-01');
    expect(b.trailing12Start).toBe('2026-01-01');
    expect(b.chartStart).toBe('2025-12-01');
  });
});
