/**
 * Money math for estimates. Extracted from the estimates API route so the
 * calculation can be characterization-tested in isolation.
 *
 * Behavior notes (intentional, matches production):
 *  - Tax applies to parts/materials only, never labor.
 *  - A line whose item NetSuite marks non-taxable (`taxable === false`,
 *    resolved by the caller from netsuite_parts.is_taxable, migration 252)
 *    is excluded from the tax base too. Freight is the case that surfaced
 *    it: FleetSuite taxed it, NetSuite did not, so the signed quote came
 *    out above the invoice. ONLY an explicit false excludes — undefined or
 *    null (unknown, custom lines, un-synced items) stays taxable, so the
 *    figure can never silently drop below what it is today.
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

export function computeTotals(lines: any[], taxRate: number, taxExempt: boolean, laborRate: number, laborHoursOverride: number | null) {
  const subtotal = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0)), 0);
  const autoLaborHours = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.labor_hours || 0) * parseFloat(l.quantity || 0)), 0);
  const effectiveLaborHours = laborHoursOverride !== null && laborHoursOverride !== undefined ? laborHoursOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  // Parts/materials only (never labor), minus anything NetSuite says is
  // non-taxable — and taxed line by line, each rounded to cents, exactly as
  // NetSuite books it.
  const taxAmount = taxExempt ? 0 : lines.reduce((sum: number, l: any) => {
    if (l.taxable === false) return sum;
    const lineAmount = parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0);
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
