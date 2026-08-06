/**
 * Money math for estimates. Extracted from the estimates API route so the
 * calculation can be characterization-tested in isolation.
 *
 * Behavior notes (intentional, matches production):
 *  - Tax applies to parts/materials only, never labor.
 *  - Per-line labor is labor_hours × quantity, matching the builder UI —
 *    a line's labor_hours is per unit, so two brackets take twice the labor.
 *    (Changed Aug 2026 with sign-off: the server used to ignore quantity,
 *    so the saved/pushed total was lower than what the rep quoted.)
 *  - A labor-hours override (including 0) replaces the per-line sum.
 *  - Each reported figure is rounded to cents independently, so
 *    grand_total can differ from the sum of the rounded parts by a cent.
 */
export function computeTotals(lines: any[], taxRate: number, taxExempt: boolean, laborRate: number, laborHoursOverride: number | null) {
  const subtotal = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.quantity || 0) * parseFloat(l.unit_price || 0)), 0);
  const autoLaborHours = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.labor_hours || 0) * parseFloat(l.quantity || 0)), 0);
  const effectiveLaborHours = laborHoursOverride !== null && laborHoursOverride !== undefined ? laborHoursOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  const taxableAmount = subtotal; // Tax on parts/materials only, not labor
  const taxAmount = taxExempt ? 0 : taxableAmount * taxRate;
  const grandTotal = subtotal + laborTotal + taxAmount;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    labor_hours: Math.round(autoLaborHours * 100) / 100,
    labor_total: Math.round(laborTotal * 100) / 100,
    tax_amount: Math.round(taxAmount * 100) / 100,
    grand_total: Math.round(grandTotal * 100) / 100,
  };
}
