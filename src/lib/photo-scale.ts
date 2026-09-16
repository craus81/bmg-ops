/**
 * Turning a photo into a ruler.
 *
 * WHAT ONE MEASUREMENT CAN AND CANNOT TELL YOU. A photo is a projection: a
 * known length fixes the scale IN ITS OWN PLANE, AT ITS OWN DISTANCE, and
 * nowhere else. So the rule is not about WHAT the reference is, it is about
 * WHERE it is: it has to sit on the same face, at the same distance, as the
 * thing being measured.
 *
 * On a storefront that makes the front door or a window frame the ideal
 * reference — it is part of the wall the signage goes on, so its inches are
 * the wall's inches. On a vehicle it is a panel, a door, the wheelbase.
 * What breaks the scale is DEPTH: a reference on a different plane (the
 * building behind a van, a side wall at an angle to the front, a car parked
 * between the camera and the storefront) is a different distance away, so
 * every inch there covers a different number of pixels. Apply that inch to
 * the surface being measured and every box is off by however much depth
 * separates the two.
 *
 * TWO CALIBRATIONS, DIFFERENT AMBITIONS.
 *
 *   line  — one dragged segment with its real length. Assumes the scale is
 *           uniform across the photo, which is exactly true of a square-on
 *           shot — the normal way to photograph a storefront — and degrades
 *           as the camera swings around: on a three-quarter view the far end
 *           of the subject is genuinely smaller on the sensor, and a uniform
 *           ruler reports it short.
 *   plane — the four corners of a known rectangle (a door, a window, a
 *           panel) with its real width and height. Four correspondences pin
 *           down a full homography, so anything in that plane can be
 *           measured with the foreshortening taken out. Worth the extra
 *           clicks when the shot could not be taken square-on.
 *
 * Both can be set on one photo. `measureRect` prefers the plane (strictly
 * more information), and `calibrationDisagreementPct` compares what the two
 * say about the same box: a big gap means the two references aren't in the
 * same plane as each other, so at least one of them isn't in the surface's
 * plane either — the depth mistake above, caught instead of quietly priced.
 *
 * Pure math, no DOM — unit-tested in photo-scale.test.ts.
 */

export interface Point { x: number; y: number }
export interface PixelRect { x: number; y: number; w: number; h: number }

/** A segment of known real length, in photo pixel coordinates. */
export interface LineScale {
  x1: number; y1: number; x2: number; y2: number;
  /** The segment's real length. */
  inches: number;
}

/**
 * A real-world rectangle seen at an angle. `corners` are its four corners in
 * photo pixels, in order: top-left, top-right, bottom-right, bottom-left AS
 * THE RECTANGLE ITSELF IS ORIENTED (the door's own top-left, not the
 * photo's).
 */
export interface PlaneScale {
  corners: Point[];
  widthIn: number;
  heightIn: number;
}

export interface PhotoCalibration {
  line?: LineScale | null;
  plane?: PlaneScale | null;
}

export interface RectMeasurement {
  widthIn: number;
  heightIn: number;
  /** True area of the mapped shape — under perspective the box becomes a
   *  quad, whose area is NOT width × height. */
  areaIn2: number;
  source: 'line' | 'plane';
}

const finite = (...ns: number[]) => ns.every(n => Number.isFinite(n));

/** Pixels per real inch along a calibration line. null when unusable. */
export function pxPerInch(line: LineScale | null | undefined): number | null {
  if (!line || !finite(line.x1, line.y1, line.x2, line.y2, line.inches)) return null;
  if (line.inches <= 0) return null;
  const px = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
  if (px <= 0) return null;
  return px / line.inches;
}

/**
 * Solve the 3×3 homography (h8 fixed at 1) mapping four image points to four
 * plane points, by direct linear transform + Gaussian elimination with
 * partial pivoting. Returns the 8 free coefficients, or null when the points
 * are degenerate (three of them collinear, duplicates) and the system has no
 * stable solution.
 */
export function solveHomography(from: Point[], to: Point[]): number[] | null {
  if (from?.length !== 4 || to?.length !== 4) return null;
  for (const p of [...from, ...to]) {
    if (!p || !finite(p.x, p.y)) return null;
  }
  // Two rows per correspondence: the projective equations rearranged so the
  // unknowns are linear.
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i];
    const { x: u, y: v } = to[i];
    A.push([x, y, 1, 0, 0, 0, -x * u, -y * u, u]);
    A.push([0, 0, 0, x, y, 1, -x * v, -y * v, v]);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r;
    }
    if (Math.abs(A[pivot][col]) < 1e-12) return null; // singular — degenerate corners
    [A[col], A[pivot]] = [A[pivot], A[col]];
    const p = A[col][col];
    for (let c = col; c <= n; c++) A[col][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) A[r][c] -= f * A[col][c];
    }
  }
  const h = A.map(row => row[n]);
  return h.every(Number.isFinite) ? h : null;
}

/** Apply a homography from solveHomography to one point. */
export function applyHomography(h: number[], p: Point): Point | null {
  const d = h[6] * p.x + h[7] * p.y + 1;
  // A point on (or past) the horizon of the calibrated plane projects to
  // infinity — refuse rather than return an astronomical inch count.
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9) return null;
  const x = (h[0] * p.x + h[1] * p.y + h[2]) / d;
  const y = (h[3] * p.x + h[4] * p.y + h[5]) / d;
  return finite(x, y) ? { x, y } : null;
}

const corners = (r: PixelRect): Point[] => ([
  { x: r.x, y: r.y },
  { x: r.x + r.w, y: r.y },
  { x: r.x + r.w, y: r.y + r.h },
  { x: r.x, y: r.y + r.h },
]);

/** Shoelace area of a simple polygon. */
const polygonArea = (pts: Point[]): number => {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
};

const dist = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** Measure a drawn box against a single known length (uniform scale). */
export function measureRectWithLine(rect: PixelRect, line: LineScale | null | undefined): RectMeasurement | null {
  const ppi = pxPerInch(line);
  if (!ppi || !rect || !finite(rect.w, rect.h) || rect.w <= 0 || rect.h <= 0) return null;
  const widthIn = rect.w / ppi;
  const heightIn = rect.h / ppi;
  return { widthIn, heightIn, areaIn2: widthIn * heightIn, source: 'line' };
}

/**
 * Measure a drawn box against a calibrated plane. The box is axis-aligned in
 * the PHOTO; mapped into the plane it becomes a quad, so width and height are
 * each the average of the two opposite sides, and the area is the quad's own.
 */
export function measureRectWithPlane(rect: PixelRect, plane: PlaneScale | null | undefined): RectMeasurement | null {
  if (!plane || !finite(plane.widthIn, plane.heightIn)) return null;
  if (plane.widthIn <= 0 || plane.heightIn <= 0) return null;
  if (!rect || !finite(rect.w, rect.h) || rect.w <= 0 || rect.h <= 0) return null;
  const h = solveHomography(plane.corners, [
    { x: 0, y: 0 },
    { x: plane.widthIn, y: 0 },
    { x: plane.widthIn, y: plane.heightIn },
    { x: 0, y: plane.heightIn },
  ]);
  if (!h) return null;
  const mapped: Point[] = [];
  for (const c of corners(rect)) {
    const m = applyHomography(h, c);
    if (!m) return null;
    mapped.push(m);
  }
  const [tl, tr, br, bl] = mapped;
  const widthIn = (dist(tl, tr) + dist(bl, br)) / 2;
  const heightIn = (dist(tl, bl) + dist(tr, br)) / 2;
  if (!finite(widthIn, heightIn) || widthIn <= 0 || heightIn <= 0) return null;
  return { widthIn, heightIn, areaIn2: polygonArea(mapped), source: 'plane' };
}

/**
 * Measure with the best calibration available: the plane when it's set (it
 * accounts for perspective), otherwise the line.
 */
export function measureRect(rect: PixelRect, cal: PhotoCalibration | null | undefined): RectMeasurement | null {
  if (!cal) return null;
  return measureRectWithPlane(rect, cal.plane) || measureRectWithLine(rect, cal.line);
}

/** Is there anything to measure with? */
export function isCalibrated(cal: PhotoCalibration | null | undefined): boolean {
  return !!(cal && (measureRectWithPlane({ x: 0, y: 0, w: 10, h: 10 }, cal.plane) || pxPerInch(cal.line)));
}

/**
 * How far apart the two calibrations are about the same box, as a percentage
 * of the larger area. Only meaningful when BOTH are set. A few percent is
 * measurement slop; a big number means the line and the rectangle are at
 * different depths, so at least one of them is not on the surface being
 * measured — and that one is lying about every box on the photo.
 */
export function calibrationDisagreementPct(
  rect: PixelRect,
  cal: PhotoCalibration | null | undefined,
): number | null {
  if (!cal?.line || !cal?.plane) return null;
  const a = measureRectWithPlane(rect, cal.plane);
  const b = measureRectWithLine(rect, cal.line);
  if (!a || !b) return null;
  const larger = Math.max(a.areaIn2, b.areaIn2);
  if (larger <= 0) return null;
  return (Math.abs(a.areaIn2 - b.areaIn2) / larger) * 100;
}

/** Above this, the app says the two references disagree instead of pricing. */
export const DISAGREEMENT_WARN_PCT = 15;

export const sqft = (areaIn2: number) => areaIn2 / 144;
