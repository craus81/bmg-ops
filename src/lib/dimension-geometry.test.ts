import { describe, expect, it } from 'vitest';
import { layoutDimension, pointToSegmentDistance } from './dimension-geometry';

describe('layoutDimension', () => {
  it('offsets a horizontal dimension upward with negative offset', () => {
    const l = layoutDimension({ x: 0, y: 100 }, { x: 200, y: 100 }, -30);
    // normal of A→B (1,0) is (0,1); offset -30 moves the line up (y=70)
    expect(l.dim[0]).toEqual({ x: 0, y: 70 });
    expect(l.dim[1]).toEqual({ x: 200, y: 70 });
    expect(l.label).toEqual({ x: 100, y: 70 });
    expect(l.angleDeg).toBe(0);
  });

  it('keeps extension lines gapped from the points and overshooting the line', () => {
    const l = layoutDimension({ x: 0, y: 100 }, { x: 200, y: 100 }, -30, {
      gap: 4,
      overshoot: 6,
    });
    expect(l.extA[0]).toEqual({ x: 0, y: 96 });
    expect(l.extA[1]).toEqual({ x: 0, y: 64 });
    expect(l.extB[0]).toEqual({ x: 200, y: 96 });
    expect(l.extB[1]).toEqual({ x: 200, y: 64 });
  });

  it('lays out vertical dimensions with an upright label angle', () => {
    const l = layoutDimension({ x: 50, y: 0 }, { x: 50, y: 300 }, 20);
    expect(l.dim[0].x).toBeCloseTo(30);
    expect(l.dim[1].x).toBeCloseTo(30);
    expect(Math.abs(l.angleDeg)).toBe(90);
  });

  it('normalizes label angles into -90..90', () => {
    const l = layoutDimension({ x: 100, y: 100 }, { x: 0, y: 90 }, 10);
    expect(l.angleDeg).toBeGreaterThanOrEqual(-90);
    expect(l.angleDeg).toBeLessThanOrEqual(90);
  });

  it('builds arrowheads whose tips sit on the dimension line ends', () => {
    const l = layoutDimension({ x: 0, y: 0 }, { x: 100, y: 0 }, 20);
    expect(l.arrowA[0]).toEqual(l.dim[0]);
    expect(l.arrowB[0]).toEqual(l.dim[1]);
  });

  it('survives a degenerate zero-length dimension', () => {
    const l = layoutDimension({ x: 5, y: 5 }, { x: 5, y: 5 }, 10);
    expect(Number.isFinite(l.label.x)).toBe(true);
    expect(Number.isFinite(l.label.y)).toBe(true);
  });
});

describe('pointToSegmentDistance', () => {
  it('measures perpendicular distance inside the span', () => {
    expect(pointToSegmentDistance({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(10);
  });

  it('clamps to endpoints outside the span', () => {
    expect(pointToSegmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(5);
  });

  it('handles zero-length segments', () => {
    expect(pointToSegmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});
