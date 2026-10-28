/**
 * graphics_jobs.quantity is a whole count of pieces / kits. Estimate and
 * sales order lines for graphics are often sold by the square foot
 * (293.2 ft²), and writing that straight into the job failed the insert
 * with "invalid input syntax for type integer" (Craig, 2026-10-28). A
 * fractional amount is a measurement, not a count, so it means one job's
 * worth: 1. A whole number of 1 or more passes through.
 */
export function graphicsJobQuantity(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) return 1;
  return n;
}
