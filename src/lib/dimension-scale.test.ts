import { describe, expect, it } from 'vitest';
import {
  distancePx,
  formatDimension,
  formatFeetInches,
  formatInches,
  pxPerRealInchFromDpi,
  pxPerRealInchFromReference,
  realInchesFromPx,
  roundToFraction,
  snapToAxis,
} from './dimension-scale';

describe('calibration', () => {
  it('derives px/real-inch from a reference line', () => {
    // 148" wheelbase traced across 740px → 5 px per real inch
    expect(pxPerRealInchFromReference(740, 148)).toBe(5);
    expect(pxPerRealInchFromReference(0, 148)).toBe(0);
    expect(pxPerRealInchFromReference(740, 0)).toBe(0);
  });

  it('derives px/real-inch from DPI at 1:20', () => {
    // 150 dpi print of a 1:20 template → 1 real inch = 150/20 = 7.5 px
    expect(pxPerRealInchFromDpi(150, 20)).toBe(7.5);
    expect(pxPerRealInchFromDpi(0, 20)).toBe(0);
  });

  it('converts pixel spans to real inches', () => {
    expect(realInchesFromPx(37.5, 7.5)).toBe(5);
    expect(realInchesFromPx(100, 0)).toBe(0);
  });

  it('measures point-to-point distance', () => {
    expect(distancePx(0, 0, 3, 4)).toBe(5);
  });
});

describe('fraction rounding', () => {
  it('rounds to nearest 1/8 and reduces', () => {
    expect(roundToFraction(62.375, 8)).toEqual({ whole: 62, num: 3, den: 8 });
    expect(roundToFraction(24.5, 8)).toEqual({ whole: 24, num: 1, den: 2 });
    expect(roundToFraction(10.26, 8)).toEqual({ whole: 10, num: 1, den: 4 });
  });

  it('carries up to the next whole inch', () => {
    expect(roundToFraction(11.99, 8)).toEqual({ whole: 12, num: 0, den: 8 });
  });

  it('handles zero and exact wholes', () => {
    expect(roundToFraction(0, 8)).toEqual({ whole: 0, num: 0, den: 8 });
    expect(roundToFraction(24, 8)).toEqual({ whole: 24, num: 0, den: 8 });
  });

  it('supports 1/16 precision', () => {
    expect(roundToFraction(5.0625, 16)).toEqual({ whole: 5, num: 1, den: 16 });
  });
});

describe('formatting', () => {
  it('formats plain inches', () => {
    expect(formatInches(62.375)).toBe('62 3/8"');
    expect(formatInches(0.5)).toBe('1/2"');
    expect(formatInches(24)).toBe('24"');
    expect(formatInches(0)).toBe('0"');
  });

  it('formats feet-inches for spans of a foot or more', () => {
    expect(formatFeetInches(62.375)).toBe(`5' 2 3/8"`);
    expect(formatFeetInches(24)).toBe(`2' 0"`);
    expect(formatFeetInches(11.5)).toBe('11 1/2"');
    expect(formatFeetInches(12.25)).toBe(`1' 1/4"`);
  });

  it('routes on units', () => {
    expect(formatDimension(62.375, 'in')).toBe('62 3/8"');
    expect(formatDimension(62.375, 'ft-in')).toBe(`5' 2 3/8"`);
  });
});

describe('axis snapping', () => {
  it('snaps near-horizontal to horizontal', () => {
    expect(snapToAxis(0, 0, 200, 5)).toEqual({ x: 200, y: 0 });
  });

  it('snaps near-vertical to vertical', () => {
    expect(snapToAxis(0, 0, 5, 200)).toEqual({ x: 0, y: 200 });
  });

  it('leaves true diagonals alone', () => {
    expect(snapToAxis(0, 0, 100, 100)).toEqual({ x: 100, y: 100 });
  });

  it('handles a zero-length drag', () => {
    expect(snapToAxis(10, 10, 10, 10)).toEqual({ x: 10, y: 10 });
  });
});
