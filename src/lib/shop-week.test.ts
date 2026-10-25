import { describe, it, expect } from 'vitest';
import { loadTone, sumEstimateHours, weekStartMonday, addDays, isGraphicsInstallLabor, graphicsHoursFromDollars, capacityWarning, overCapacity } from './shop-week';

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

describe('graphics install hours', () => {
  it('recognises both shapes of the graphics install labor line', () => {
    expect(isGraphicsInstallLabor({ item_number: 'Graphics Install Labor' })).toBe(true);
    expect(isGraphicsInstallLabor({ item_number: ' GRAPHICS INSTALL LABOR ' })).toBe(true);
    expect(isGraphicsInstallLabor({ item_number: '', description: 'Graphics install labor — Wrap' })).toBe(true);
    expect(isGraphicsInstallLabor({ item_number: '3M Vinyl', description: 'Vinyl — 120 sqft @ $9.00/sqft' })).toBe(false);
    expect(isGraphicsInstallLabor({ item_number: 'LABOR', description: 'Upfit labor' })).toBe(false);
  });

  it('divides dollars by the rate, and stays unknown without a rate or dollars', () => {
    expect(graphicsHoursFromDollars(1239.1, 95)).toBe(13);
    expect(graphicsHoursFromDollars(500, null)).toBeNull();
    expect(graphicsHoursFromDollars(0, 95)).toBeNull();
    expect(graphicsHoursFromDollars(null, 95)).toBeNull();
  });
});

describe('capacityWarning', () => {
  const day = { demandHours: 30, capacityHours: 40, graphicsDemandHours: 4, graphicsCapacityHours: 8, knownHours: 3, totalUnits: 3 };

  it('is quiet when both departments fit, or when nothing is configured', () => {
    expect(capacityWarning(day)).toBeNull();
    expect(capacityWarning({ ...day, demandHours: 40 })).toBeNull(); // exactly full still fits
    expect(capacityWarning({ ...day, demandHours: 90, capacityHours: null, graphicsCapacityHours: null })).toBeNull();
    expect(overCapacity(41, 40)).toBe(true);
  });

  it('names each department that is over, and flags unknown hours', () => {
    expect(capacityWarning({ ...day, demandHours: 52, capacityHours: 43 }))
      .toBe('Over capacity that day: upfit 52 of 43 hours.');
    expect(capacityWarning({ ...day, demandHours: 52, graphicsDemandHours: 12, knownHours: 1 }))
      .toBe('Over capacity that day: upfit 52 of 40 hours, graphics install 12 of 8 hours. 2 vehicles have no labor hours yet, so the real load is higher.');
  });
});
