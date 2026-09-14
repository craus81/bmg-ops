import { describe, it, expect } from 'vitest';
import { referenceDimensions, calibrationDelta } from './wrap-reference';

// The Chevy Express row migration 031 hand-filled, as it actually sits in
// vehicle_templates.
const express = {
  overall_length_in: 217.4,
  overall_height_in: 72,
  wheelbase_in: 135,
  panel_data: [
    { name: 'Driver Side', width_in: 222, height_in: 72, area_sqft: 111 },
    { name: 'Passenger Side', width_in: 222, height_in: 72, area_sqft: 111 },
    { name: 'Rear', width_in: 78, height_in: 60, area_sqft: 39 },
    { name: 'Roof', width_in: 171, height_in: 75, area_sqft: 89.06 },
  ],
};

describe('referenceDimensions', () => {
  it('offers the longest reference first', () => {
    const refs = referenceDimensions(express);
    expect(refs[0]).toMatchObject({ label: 'Driver Side — width', inches: 222 });
    expect(refs.map(r => r.inches)).toEqual([...refs.map(r => r.inches)].sort((a, b) => b - a));
  });

  it('collapses a vehicle’s two identical sides into one yardstick', () => {
    const refs = referenceDimensions(express);
    expect(refs.filter(r => r.inches === 222)).toHaveLength(1);
    // 72" is the overall height AND both side heights — listed once.
    expect(refs.filter(r => r.inches === 72)).toHaveLength(1);
  });

  it('carries the overall dimensions alongside the panels', () => {
    const labels = referenceDimensions(express).map(r => r.label);
    expect(labels).toContain('Overall length');
    expect(labels).toContain('Wheelbase');
    expect(labels).toContain('Roof — width');
  });

  it('drops missing, zero, and unparseable dimensions', () => {
    const refs = referenceDimensions({
      overall_length_in: 0,
      overall_height_in: null,
      wheelbase_in: undefined,
      panel_data: [
        { name: 'Rear', width_in: null, height_in: 60 },
        { name: 'Junk', width_in: NaN, height_in: 0 },
      ],
    });
    expect(refs).toEqual([{ key: 'panel-0-h', label: 'Rear — height', inches: 60, kind: 'panel' }]);
  });

  it('falls back to a label, then a position, when a panel has no name', () => {
    const refs = referenceDimensions({ panel_data: [{ name: '', label: 'A', width_in: 100 }, { name: '', width_in: 50 }] });
    expect(refs.map(r => r.label)).toEqual(['A — width', 'Panel 2 — width']);
  });

  it('handles a template with no reference data at all', () => {
    expect(referenceDimensions(null)).toEqual([]);
    expect(referenceDimensions({})).toEqual([]);
    expect(referenceDimensions({ panel_data: [] })).toEqual([]);
  });

  it('keeps keys stable and unique so the picker doesn’t shuffle', () => {
    const keys = referenceDimensions(express).map(r => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(referenceDimensions(express).map(r => r.key)).toEqual(keys);
  });
});

describe('calibrationDelta', () => {
  it('reports the scale a traced line implies', () => {
    expect(calibrationDelta(444, 222, null)).toMatchObject({ pxPerIn: 2, linearRatio: null, areaRatio: null });
  });

  it('squares the linear change, because quotes bill area', () => {
    // Stored scale is 16% too small, so panels currently measure long.
    const d = calibrationDelta(444, 222, 2 / 1.16)!;
    expect(d.pxPerIn).toBe(2);
    expect(d.linearRatio!).toBeCloseTo(1 / 1.16, 4);
    expect(d.areaRatio!).toBeCloseTo(1 / 1.3456, 3);
  });

  it('reads 1.0 both ways when the stored scale already agrees', () => {
    const d = calibrationDelta(444, 222, 2)!;
    expect(d.linearRatio).toBeCloseTo(1, 6);
    expect(d.areaRatio).toBeCloseTo(1, 6);
  });

  it('refuses a degenerate line or reference', () => {
    expect(calibrationDelta(0, 222, 2)).toBeNull();
    expect(calibrationDelta(444, 0, 2)).toBeNull();
    expect(calibrationDelta(444, -5, 2)).toBeNull();
  });
});
