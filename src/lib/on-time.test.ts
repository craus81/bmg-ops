import { describe, it, expect } from 'vitest';
import { classifyPromise, dateDiffDays, summarizeOnTime, type CompletionRow } from './on-time';

describe('classifyPromise — promised-back outcome', () => {
  it('completing ON the promised day is on time', () => {
    expect(classifyPromise('2026-09-07', '2026-09-07')).toBe('on_time');
    expect(classifyPromise('2026-09-07', '2026-09-01')).toBe('on_time');
  });
  it('the day after is late', () => {
    expect(classifyPromise('2026-09-07', '2026-09-08')).toBe('late');
  });
  it('no promise recorded', () => {
    expect(classifyPromise(null, '2026-09-08')).toBe('no_promise');
  });
});

describe('dateDiffDays', () => {
  it('forward, backward, same day', () => {
    expect(dateDiffDays('2026-09-01', '2026-09-08')).toBe(7);
    expect(dateDiffDays('2026-09-08', '2026-09-01')).toBe(-7);
    expect(dateDiffDays('2026-09-07', '2026-09-07')).toBe(0);
  });
  it('crosses month and year boundaries', () => {
    expect(dateDiffDays('2026-08-31', '2026-09-02')).toBe(2);
    expect(dateDiffDays('2025-12-30', '2026-01-02')).toBe(3);
  });
});

describe('summarizeOnTime', () => {
  const row = (over: Partial<CompletionRow>): CompletionRow => ({
    vehicleId: 'v', customerName: 'Acme', promised: '2026-09-05', completedDay: '2026-09-04', ...over,
  });

  it('pct counts only completions that had a promise; no-promise is its own number', () => {
    const s = summarizeOnTime([
      row({ vehicleId: 'a' }), // on time
      row({ vehicleId: 'b', completedDay: '2026-09-08' }), // 3 days late
      row({ vehicleId: 'c', promised: null }), // no promise
    ]);
    expect(s.overall).toMatchObject({ completed: 3, onTime: 1, late: 1, noPromise: 1, pct: 50 });
    expect(s.overall.avgDaysLate).toBe(3);
  });

  it('groups by completion month, oldest first', () => {
    const s = summarizeOnTime([
      row({ vehicleId: 'a', completedDay: '2026-08-20', promised: '2026-08-25' }),
      row({ vehicleId: 'b', completedDay: '2026-09-02', promised: '2026-09-01' }),
    ]);
    expect(s.monthly.map(m => m.month)).toEqual(['2026-08', '2026-09']);
    expect(s.monthly[0].pct).toBe(100);
    expect(s.monthly[1]).toMatchObject({ late: 1, pct: 0, avgDaysLate: 1 });
  });

  it('per-customer sorted by completions, blank names bucketed', () => {
    const s = summarizeOnTime([
      row({ vehicleId: 'a', customerName: 'Beta' }),
      row({ vehicleId: 'b', customerName: 'Beta' }),
      row({ vehicleId: 'c', customerName: '  ' }),
    ]);
    expect(s.perCustomer[0]).toMatchObject({ customer: 'Beta', completed: 2 });
    expect(s.perCustomer[1].customer).toBe('(no customer)');
  });

  it('all-no-promise window has null pct', () => {
    const s = summarizeOnTime([row({ promised: null })]);
    expect(s.overall.pct).toBeNull();
  });
});
