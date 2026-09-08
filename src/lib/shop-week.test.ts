import { describe, it, expect } from 'vitest';
import { loadTone, sumEstimateHours, weekStartMonday, addDays } from './shop-week';

describe('loadTone', () => {
  it('greens under 85%, ambers to 110%, reds past that', () => {
    expect(loadTone(50, 100)).toEqual({ tone: 'green', pct: 50 });
    expect(loadTone(84.4, 100).tone).toBe('green');
    expect(loadTone(85, 100)).toEqual({ tone: 'amber', pct: 85 });
    expect(loadTone(110, 100).tone).toBe('amber');
    expect(loadTone(111, 100)).toEqual({ tone: 'red', pct: 111 });
  });

  it('never judges without a denominator — unset or zero capacity is tone none', () => {
    expect(loadTone(40, null)).toEqual({ tone: 'none', pct: null });
    expect(loadTone(40, 0)).toEqual({ tone: 'none', pct: null });
  });

  it('an empty day is quiet, not green', () => {
    expect(loadTone(0, 100)).toEqual({ tone: 'none', pct: 0 });
  });
});

describe('sumEstimateHours', () => {
  it('SUMs effective hours across linked estimates (override wins per estimate)', () => {
    expect(sumEstimateHours([
      { labor_hours: 4, labor_hours_override: null },
      { labor_hours: 2, labor_hours_override: 6 }, // override wins
    ])).toBe(10);
  });

  it('skips unknown estimates but keeps the known ones', () => {
    expect(sumEstimateHours([
      { labor_hours: null, labor_hours_override: null },
      { labor_hours: 3.5, labor_hours_override: null },
    ])).toBe(3.5);
  });

  it('all-unknown stays unknown — never reads as zero demand', () => {
    expect(sumEstimateHours([{ labor_hours: null, labor_hours_override: null }])).toBeNull();
    expect(sumEstimateHours([])).toBeNull();
  });
});

describe('weekStartMonday', () => {
  it('snaps any day back to its Monday', () => {
    expect(weekStartMonday('2026-09-08')).toBe('2026-09-07'); // Tuesday → Monday
    expect(weekStartMonday('2026-09-07')).toBe('2026-09-07'); // Monday stays
    expect(weekStartMonday('2026-09-13')).toBe('2026-09-07'); // Sunday belongs to the week behind it
  });

  it('crosses month boundaries', () => {
    expect(weekStartMonday('2026-10-01')).toBe('2026-09-28');
  });
});

describe('addDays', () => {
  it('walks forward across months', () => {
    expect(addDays('2026-09-28', 7)).toBe('2026-10-05');
  });
});
