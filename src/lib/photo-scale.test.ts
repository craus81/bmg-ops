import { describe, it, expect } from 'vitest';
import {
  pxPerInch,
  solveHomography,
  applyHomography,
  measureRectWithLine,
  measureRectWithPlane,
  measureRect,
  calibrationDisagreementPct,
  isCalibrated,
  sqft,
  type PlaneScale,
  type Point,
} from './photo-scale';

describe('pxPerInch', () => {
  it('divides the drawn length by the real one', () => {
    // 200 px across something 50" wide = 4 px per inch.
    expect(pxPerInch({ x1: 100, y1: 100, x2: 300, y2: 100, inches: 50 })).toBe(4);
  });

  it('measures the segment, not its horizontal run', () => {
    expect(pxPerInch({ x1: 0, y1: 0, x2: 30, y2: 40, inches: 10 })).toBeCloseTo(5, 10);
  });

  it('refuses nonsense rather than returning Infinity or 0', () => {
    expect(pxPerInch({ x1: 0, y1: 0, x2: 0, y2: 0, inches: 10 })).toBeNull();
    expect(pxPerInch({ x1: 0, y1: 0, x2: 10, y2: 0, inches: 0 })).toBeNull();
    expect(pxPerInch({ x1: 0, y1: 0, x2: 10, y2: 0, inches: -5 })).toBeNull();
    expect(pxPerInch({ x1: NaN, y1: 0, x2: 10, y2: 0, inches: 5 })).toBeNull();
    expect(pxPerInch(null)).toBeNull();
  });
});

describe('measureRectWithLine', () => {
  const line = { x1: 0, y1: 0, x2: 100, y2: 0, inches: 25 }; // 4 px/in

  it('converts a box to inches and square inches', () => {
    const m = measureRectWithLine({ x: 10, y: 10, w: 240, h: 120 }, line);
    expect(m!.widthIn).toBeCloseTo(60, 10);
    expect(m!.heightIn).toBeCloseTo(30, 10);
    expect(m!.areaIn2).toBeCloseTo(1800, 10);
    expect(sqft(m!.areaIn2)).toBeCloseTo(12.5, 10);
    expect(m!.source).toBe('line');
  });

  it('is null without a usable line or box', () => {
    expect(measureRectWithLine({ x: 0, y: 0, w: 10, h: 10 }, null)).toBeNull();
    expect(measureRectWithLine({ x: 0, y: 0, w: 0, h: 10 }, line)).toBeNull();
  });
});

describe('solveHomography', () => {
  it('recovers an exact mapping for a square-on rectangle', () => {
    const img: Point[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }];
    const plane: Point[] = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }];
    const h = solveHomography(img, plane)!;
    expect(h).not.toBeNull();
    const mid = applyHomography(h, { x: 50, y: 25 })!;
    expect(mid.x).toBeCloseTo(20, 8);
    expect(mid.y).toBeCloseTo(10, 8);
  });

  it('refuses degenerate corners instead of returning garbage', () => {
    const collinear: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }];
    const plane: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    expect(solveHomography(collinear, plane)).toBeNull();
    expect(solveHomography([{ x: 0, y: 0 }], plane)).toBeNull();
    expect(solveHomography([{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], plane)).toBeNull();
  });
});

describe('measureRectWithPlane', () => {
  it('matches the line answer when the photo is square-on', () => {
    // A 40"×20" door photographed head on at 5 px/in.
    const plane: PlaneScale = {
      corners: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
      widthIn: 40, heightIn: 20,
    };
    const m = measureRectWithPlane({ x: 0, y: 0, w: 500, h: 250 }, plane)!;
    expect(m.widthIn).toBeCloseTo(100, 8);
    expect(m.heightIn).toBeCloseTo(50, 8);
    expect(m.areaIn2).toBeCloseTo(5000, 6);
    expect(m.source).toBe('plane');
  });

  /**
   * The case a single line cannot handle. Build a synthetic perspective: a
   * real 120"×60" wall plane photographed at an angle, so the far edge is
   * compressed. Feed the solver the image corners of a known 30"×30" decal
   * on that wall, then measure a panel at the FAR end and check the true
   * size comes back.
   */
  it('recovers true sizes under perspective, where a uniform ruler cannot', () => {
    // Projection: plane inches (u,v) → image px, with a horizontal squeeze
    // that grows with u (the far end of the wall).
    const project = (u: number, v: number): Point => {
      const d = 1 + u / 300;           // depth grows across the wall
      return { x: (u * 4) / d, y: ((v - 30) * 4) / d + 200 };
    };
    // The known reference: a 30"×30" decal at the NEAR end of the wall.
    const plane: PlaneScale = {
      corners: [project(0, 0), project(30, 0), project(30, 30), project(0, 30)],
      widthIn: 30, heightIn: 30,
    };

    // A panel at the FAR end, 200"→260" across and 0"→40" down.
    const far = [project(200, 0), project(260, 0), project(260, 40), project(200, 40)];
    const rect = {
      x: Math.min(...far.map(p => p.x)),
      y: Math.min(...far.map(p => p.y)),
      w: Math.max(...far.map(p => p.x)) - Math.min(...far.map(p => p.x)),
      h: Math.max(...far.map(p => p.y)) - Math.min(...far.map(p => p.y)),
    };

    const withPlane = measureRectWithPlane(rect, plane)!;
    expect(withPlane.widthIn).toBeCloseTo(60, 0);   // true 60" wide
    // Height comes back a few inches OVER the panel's 40", and correctly so:
    // on an angled shot the panel's image is a trapezoid, and the box drawn
    // over it is axis-aligned — so it encloses the panel plus a sliver above
    // and below. The plane calibration measures the region the box actually
    // covers; it can't know the user meant only the trapezoid inside it.
    expect(withPlane.heightIn).toBeGreaterThan(40);
    expect(withPlane.heightIn).toBeLessThan(44);

    // The same box measured with a uniform ruler taken from the NEAR decal
    // (4 px/in there) reads materially short, because the far end really is
    // smaller on the sensor. This is the error the plane calibration removes.
    const line = { x1: 0, y1: 0, x2: 120, y2: 0, inches: 30 };
    const withLine = measureRectWithLine(rect, line)!;
    expect(withLine.widthIn).toBeLessThan(45);
    expect(withPlane.areaIn2).toBeGreaterThan(withLine.areaIn2 * 1.5);
  });

  it('is null when the plane has no real dimensions', () => {
    const corners = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    expect(measureRectWithPlane({ x: 0, y: 0, w: 5, h: 5 }, { corners, widthIn: 0, heightIn: 10 })).toBeNull();
    expect(measureRectWithPlane({ x: 0, y: 0, w: 5, h: 5 }, null)).toBeNull();
  });
});

describe('measureRect', () => {
  const line = { x1: 0, y1: 0, x2: 100, y2: 0, inches: 50 }; // 2 px/in
  const plane: PlaneScale = {
    corners: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
    widthIn: 40, heightIn: 20, // 5 px/in
  };

  it('prefers the plane — it is the one that accounts for perspective', () => {
    const m = measureRect({ x: 0, y: 0, w: 100, h: 50 }, { line, plane })!;
    expect(m.source).toBe('plane');
    expect(m.widthIn).toBeCloseTo(20, 8); // 100 px ÷ 5 px/in
  });

  it('falls back to the line when there is no plane', () => {
    const m = measureRect({ x: 0, y: 0, w: 100, h: 50 }, { line })!;
    expect(m.source).toBe('line');
    expect(m.widthIn).toBeCloseTo(50, 8); // 100 px ÷ 2 px/in
  });

  it('is null with nothing calibrated', () => {
    expect(measureRect({ x: 0, y: 0, w: 10, h: 10 }, {})).toBeNull();
    expect(measureRect({ x: 0, y: 0, w: 10, h: 10 }, null)).toBeNull();
    expect(isCalibrated({})).toBe(false);
    expect(isCalibrated({ line })).toBe(true);
    expect(isCalibrated({ plane })).toBe(true);
  });
});

describe('calibrationDisagreementPct', () => {
  const plane: PlaneScale = {
    corners: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
    widthIn: 40, heightIn: 20, // 5 px/in
  };

  it('is ~0 when both references agree', () => {
    const line = { x1: 0, y1: 0, x2: 200, y2: 0, inches: 40 }; // also 5 px/in
    expect(calibrationDisagreementPct({ x: 0, y: 0, w: 100, h: 100 }, { line, plane })!)
      .toBeCloseTo(0, 6);
  });

  it('flags a reference taken from a different depth', () => {
    // The "door on the building behind the van" line: 2.5 px/in where the
    // vehicle's own plane is 5 px/in. Areas differ 4×.
    const line = { x1: 0, y1: 0, x2: 100, y2: 0, inches: 40 };
    const pct = calibrationDisagreementPct({ x: 0, y: 0, w: 100, h: 100 }, { line, plane })!;
    expect(pct).toBeGreaterThan(15);
  });

  it('needs both calibrations to say anything', () => {
    expect(calibrationDisagreementPct({ x: 0, y: 0, w: 10, h: 10 }, { plane })).toBeNull();
    expect(calibrationDisagreementPct({ x: 0, y: 0, w: 10, h: 10 }, null)).toBeNull();
  });
});
