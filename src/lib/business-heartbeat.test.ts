import { describe, it, expect } from 'vitest';
import {
  baselineOf,
  evaluateShortfall,
  evaluateRise,
  sameWeekdayDates,
  isBusinessDay,
  summarize,
  MIN_BASELINE_POINTS,
  BASELINE_WEEKS,
} from './business-heartbeat';

describe('baselineOf', () => {
  it('averages the days it has', () => {
    expect(baselineOf([10, 20, 30])).toEqual({ mean: 20, points: 3 });
  });
  it('ignores gaps rather than treating them as zero', () => {
    // A day with no figure is unmeasured, not a day of no work — averaging
    // it in as 0 would drag every baseline down and fire false alarms.
    expect(baselineOf([10, null, 20, undefined])).toEqual({ mean: 15, points: 2 });
  });
  it('reports no baseline at all when nothing is known', () => {
    expect(baselineOf([null, undefined])).toEqual({ mean: null, points: 0 });
  });
});

describe('evaluateShortfall', () => {
  const base = { key: 'scans', label: 'Scans', dropFraction: 0.6, noun: 'scans' };

  it('trips when today is far below the same-weekday average', () => {
    const c = evaluateShortfall({ ...base, today: 2, history: [20, 22, 18, 20] });
    expect(c.status).toBe('tripped');
    expect(c.detail).toContain('90% down');
  });

  it('stays quiet on a normal day', () => {
    expect(evaluateShortfall({ ...base, today: 19, history: [20, 22, 18, 20] }).status).toBe('ok');
  });

  it('is UNKNOWN, not ok, when today could not be measured', () => {
    const c = evaluateShortfall({ ...base, today: null, history: [20, 22, 18, 20] });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain('Could not measure');
  });

  it('is UNKNOWN, not tripped, when the baseline is too thin', () => {
    const c = evaluateShortfall({ ...base, today: 0, history: [20] });
    expect(c.status).toBe('unknown');
    expect(c.baselinePoints).toBe(1);
    expect(c.detail).toContain(`${MIN_BASELINE_POINTS} needed`);
  });

  it('is UNKNOWN when the same weekday has always been zero', () => {
    // Otherwise every Sunday reports a 100% collapse, forever.
    const c = evaluateShortfall({ ...base, today: 0, history: [0, 0, 0, 0] });
    expect(c.status).toBe('unknown');
    expect(c.detail).toContain('nothing to compare against');
  });

  it('trips exactly at the threshold, not only past it', () => {
    expect(evaluateShortfall({ ...base, today: 4, history: [10, 10, 10] }).status).toBe('tripped');
  });

  it('carries the numbers it judged on, so the alert can be checked', () => {
    const c = evaluateShortfall({ ...base, today: 2, history: [20, 20, 20] });
    expect(c.value).toBe(2);
    expect(c.baseline).toBe(20);
    expect(c.baselinePoints).toBe(3);
  });
});

describe('evaluateRise', () => {
  const base = { key: 'ar60', label: 'A/R over 60', riseFraction: 0.25, minAbsolute: 5000, noun: 'over 60 days' };

  it('trips on a big enough jump in both percentage AND dollars', () => {
    expect(evaluateRise({ ...base, today: 40000, history: [20000, 20000, 20000] }).status).toBe('tripped');
  });

  it('does NOT trip on a large percentage that is small in absolute terms', () => {
    // Doubling from $10 to $20 is +100% and completely uninteresting.
    const c = evaluateRise({ ...base, today: 20, history: [10, 10, 10] });
    expect(c.status).toBe('ok');
  });

  it('does not trip on a big dollar move that is a small percentage', () => {
    expect(evaluateRise({ ...base, today: 106000, history: [100000, 100000, 100000] }).status).toBe('ok');
  });

  it('reports a rise from a zero baseline only when it is material', () => {
    expect(evaluateRise({ ...base, today: 9000, history: [0, 0, 0] }).status).toBe('tripped');
    expect(evaluateRise({ ...base, today: 100, history: [0, 0, 0] }).status).toBe('ok');
  });

  it('is unknown when today could not be measured', () => {
    expect(evaluateRise({ ...base, today: null, history: [1, 2, 3] }).status).toBe('unknown');
  });
});

describe('sameWeekdayDates', () => {
  it('walks back one week at a time', () => {
    const days = sameWeekdayDates(new Date('2026-09-11T18:00:00Z'), 4);
    expect(days).toEqual(['2026-09-04', '2026-08-28', '2026-08-21', '2026-08-14']);
    expect(days).toHaveLength(BASELINE_WEEKS);
  });
  it('never includes the day itself', () => {
    expect(sameWeekdayDates(new Date('2026-09-11T18:00:00Z'))).not.toContain('2026-09-11');
  });
});

describe('isBusinessDay', () => {
  it('counts Monday to Friday', () => {
    expect(isBusinessDay('2026-09-07')).toBe(true);  // Monday
    expect(isBusinessDay('2026-09-11')).toBe(true);  // Friday
  });
  it('excludes the weekend', () => {
    expect(isBusinessDay('2026-09-12')).toBe(false); // Saturday
    expect(isBusinessDay('2026-09-13')).toBe(false); // Sunday
  });
});

describe('summarize', () => {
  it('separates tripped from unknown, and counts neither as ok', () => {
    const r = summarize('2026-09-11', [
      { key: 'a', label: 'A', status: 'ok', detail: '', value: 1, baseline: 1, baselinePoints: 4 },
      { key: 'b', label: 'B', status: 'tripped', detail: '', value: 0, baseline: 9, baselinePoints: 4 },
      { key: 'c', label: 'C', status: 'unknown', detail: '', value: null, baseline: null, baselinePoints: 0 },
    ]);
    expect(r.tripped.map(c => c.key)).toEqual(['b']);
    expect(r.unknown.map(c => c.key)).toEqual(['c']);
  });
});
