// Pure math for the scale-template dimension editor (install guides).
//
// Everything is anchored on one canonical number per template page:
// pxPerRealInch — how many image pixels equal one inch on the actual
// vehicle. Both calibration paths produce it:
//   - reference line: the user traces a feature of known real length
//   - print DPI: a 1:20 template printed/rasterized at N dpi means
//     N pixels = 1 template inch = `scaleRatio` real inches

/** px/real-inch from a traced reference line of known real-world length. */
export function pxPerRealInchFromReference(lengthPx: number, realInches: number): number {
  if (!(lengthPx > 0) || !(realInches > 0)) return 0;
  return lengthPx / realInches;
}

/** px/real-inch from raster DPI + template scale (1:20 → scaleRatio 20). */
export function pxPerRealInchFromDpi(dpi: number, scaleRatio: number): number {
  if (!(dpi > 0) || !(scaleRatio > 0)) return 0;
  return dpi / scaleRatio;
}

export function distancePx(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

export function realInchesFromPx(lengthPx: number, pxPerRealInch: number): number {
  if (!(pxPerRealInch > 0)) return 0;
  return lengthPx / pxPerRealInch;
}

/** Round to the nearest 1/denominator inch and reduce the fraction. */
export function roundToFraction(
  inches: number,
  denominator: number,
): { whole: number; num: number; den: number } {
  const den = denominator > 0 ? Math.round(denominator) : 8;
  const totalUnits = Math.round(inches * den);
  let whole = Math.trunc(totalUnits / den);
  let num = Math.abs(totalUnits % den);
  let d = den;
  while (num % 2 === 0 && num > 0 && d % 2 === 0) {
    num /= 2;
    d /= 2;
  }
  if (num === 0) d = den;
  // 7.999 at /8 rounds up to the next whole inch
  if (num === d) {
    whole += totalUnits < 0 ? -1 : 1;
    num = 0;
    d = den;
  }
  return { whole, num, den: d };
}

/** 62.375 → `62 3/8"`; 0.5 → `1/2"`; 24 → `24"`. */
export function formatInches(inches: number, denominator = 8): string {
  const { whole, num, den } = roundToFraction(inches, denominator);
  if (num === 0) return `${whole}"`;
  if (whole === 0) return `${num}/${den}"`;
  return `${whole} ${num}/${den}"`;
}

/** 62.375 → `5' 2 3/8"` (feet only when >= 12"). */
export function formatFeetInches(inches: number, denominator = 8): string {
  const { whole, num, den } = roundToFraction(inches, denominator);
  const sign = whole < 0 ? '-' : '';
  const absWhole = Math.abs(whole);
  if (absWhole < 12) return formatInches(inches, denominator);
  const feet = Math.trunc(absWhole / 12);
  const rem = absWhole % 12;
  const inchPart = num === 0 ? `${rem}"` : rem === 0 ? `${num}/${den}"` : `${rem} ${num}/${den}"`;
  return `${sign}${feet}' ${inchPart}`;
}

export type DimUnits = 'in' | 'ft-in';

export function formatDimension(inches: number, units: DimUnits, denominator = 8): string {
  return units === 'ft-in' ? formatFeetInches(inches, denominator) : formatInches(inches, denominator);
}

/**
 * Snap a dimension's second endpoint to horizontal/vertical when it is
 * within `toleranceDeg` of an axis (used unless the user holds Alt).
 */
export function snapToAxis(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  toleranceDeg = 4,
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return { x: x2, y: y2 };
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angle <= toleranceDeg) return { x: x2, y: y1 };
  if (angle >= 90 - toleranceDeg) return { x: x1, y: y2 };
  return { x: x2, y: y2 };
}
