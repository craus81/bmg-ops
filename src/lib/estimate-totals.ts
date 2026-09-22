/**
 * Money math for estimates. Extracted from the estimates API route so the
 * calculation can be characterization-tested in isolation.
 *
 * Behavior notes (intentional, matches production):
 *  - Tax applies to parts/materials only, never labor. EVERY non-labor
 *    line is taxed; a tax-exempt CUSTOMER is the only thing that zeroes it
 *    (the estimate's own checkbox).
 *  - Per-ITEM taxability was tried and removed. Migration 252 excluded any
 *    line whose NetSuite item had the Taxable box unticked, because on
 *    EST942 Freight was non-taxable there and FleetSuite taxed it, putting
 *    the signed quote $11.94 above the invoice. In practice that checkbox
 *    is not maintained in this account: a Sep 2026 quote came out with
 *    $6,848.61 of ordinary parts excluded and $175 of FREIGHT as the only
 *    taxed line — the exact inverse of the case it was built for — while
 *    NetSuite's own invoice taxed all of it. An unmaintained flag that
 *    silently shrinks the tax base under-quotes tax on a document the
 *    customer SIGNS, which is the expensive direction to be wrong in; a
 *    quote that is a few dollars high is corrected at invoicing.
 *    `netsuite_parts.is_taxable` is still mirrored for reference, but
 *    nothing reads it for money. If per-line taxability is ever wanted
 *    again it has to come from the customer's NetSuite tax code, which is
 *    what actually decides this, not from the item record.
 *  - Per-line labor is labor_hours × quantity, matching the builder UI —
 *    a line's labor_hours is per unit, so two brackets take twice the labor.
 *    (Changed Aug 2026 with sign-off: the server used to ignore quantity,
 *    so the saved/pushed total was lower than what the rep quoted.)
 *  - A labor-hours override (including 0) replaces the per-line sum.
 *  - Tax is computed PER LINE, rounded to cents, then summed — the way
 *    NetSuite does it, so the quote and the invoice agree to the penny.
 *    Taxing the combined base instead drifts by a cent or two on real
 *    estimates (EST-2608-024: $309.77 our way, $309.76 NetSuite's).
 *  - Ties round half-to-even, again matching NetSuite: 4 × $697.50 at
 *    7.95% is exactly $221.805, which NetSuite books as $221.80, not
 *    $221.81. Only an exact half-cent is affected.
 *  - Each reported figure is rounded to cents independently, so
 *    grand_total can differ from the sum of the rounded parts by a cent.
 *  - A fleet estimate (vehicleCount > 1, migration 304) multiplies LINE
 *    QUANTITIES, never the finished totals. Multiplying totals would break
 *    the per-line tax rounding above — round(lineTax) × N is not
 *    round(lineTax × N) — and quantities are what the sales order carries,
 *    so the pushed copy needs no second interpretation of the count.
 *    labor_hours and labor_hours_override stay JOB totals: an override is
 *    the hours for the whole job, which is what the field already meant.
 */

/**
 * Round to cents, breaking exact half-cent ties toward the even cent.
 *
 * The float scrub before the tie test is load-bearing: 221.805 × 100 is
 * 22180.500000000004 in IEEE754, so a naive `=== 0.5` never fires and the
 * tie silently rounds up — which is the cent this function exists to stop.
 */
export function roundCentsHalfEven(value: number): number {
  const scaled = Math.round(value * 100 * 1e6) / 1e6;
  const lower = Math.floor(scaled);
  const cents = Math.abs(scaled - lower - 0.5) < 1e-9
    ? (lower % 2 === 0 ? lower : lower + 1)
    : Math.round(scaled);
  return cents / 100;
}

/** A count below 1 is not a quote for zero vehicles — it is bad input. */
export function normalizeVehicleCount(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export function computeTotals(
  lines: any[],
  taxRate: number,
  taxExempt: boolean,
  laborRate: number,
  laborHoursOverride: number | null,
  vehicleCount: unknown = 1,
) {
  const units = normalizeVehicleCount(vehicleCount);
  const qtyOf = (l: any) => (parseFloat(l.quantity || 0) || 0) * units;
  const subtotal = lines.reduce((sum: number, l: any) => sum + (qtyOf(l) * parseFloat(l.unit_price || 0)), 0);
  const autoLaborHours = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.labor_hours || 0) * qtyOf(l)), 0);
  const effectiveLaborHours = laborHoursOverride !== null && laborHoursOverride !== undefined ? laborHoursOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  // Parts/materials only (never labor), taxed line by line, each rounded to
  // cents, exactly as NetSuite books it. The line amount here is the FLEET
  // amount (qty × units) because that is the quantity the sales order will
  // carry. No per-item exclusion — see the note at the top of this file.
  const taxAmount = taxExempt ? 0 : lines.reduce((sum: number, l: any) => {
    const lineAmount = qtyOf(l) * parseFloat(l.unit_price || 0);
    return sum + roundCentsHalfEven(lineAmount * taxRate);
  }, 0);
  const grandTotal = subtotal + laborTotal + taxAmount;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    labor_hours: Math.round(autoLaborHours * 100) / 100,
    labor_total: Math.round(laborTotal * 100) / 100,
    tax_amount: Math.round(taxAmount * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100,
  };
}

/**
 * The per-vehicle figure a fleet estimate shows beside its total.
 *
 * Derived by division, so it does not always multiply back exactly — a
 * $64,056.01 total over 12 vehicles is $5,338.0008 each. `exact` says
 * whether it does, so the document can mark an approximation rather than
 * print a number a customer will multiply and find wrong by a cent.
 */
export function perVehicleAmount(grandTotal: unknown, vehicleCount: unknown): { amount: number; exact: boolean } | null {
  const units = normalizeVehicleCount(vehicleCount);
  if (units <= 1) return null;
  const total = parseFloat(String(grandTotal ?? 0)) || 0;
  const amount = Math.round((total / units) * 100) / 100;
  return { amount, exact: Math.abs(amount * units - total) < 0.005 };
}
