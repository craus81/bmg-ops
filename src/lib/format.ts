/**
 * Display formatters for physical measurements. DISPLAY ONLY — pricing math
 * (wrap-quote computeUsage/totals, buildSnapshot, NetSuite payloads) keeps
 * raw floats; rounding there would change quoted money.
 *
 * Raw canvas geometry divides pixels by a calibration ratio, so unformatted
 * values print like 47.382978723404256 — these exist so no customer- or
 * production-facing string ever shows that.
 */

/** Inches for humans: 1 decimal, no trailing .0 (47.4, 92). */
export function fmtInches(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** Square feet for humans: 1 decimal, no trailing .0 (216.5, 84). */
export function fmtSqft(n: number | null | undefined): string {
  const v = Number(n) || 0;
  const r = Math.round(v * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}
