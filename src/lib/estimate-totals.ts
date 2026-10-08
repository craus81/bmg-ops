/**
 * Money math for estimates. Extracted from the estimates API route so the
 * calculation can be characterization-tested in isolation.
 *
 * Behavior notes (intentional, matches production):
 *  - Tax applies to parts/materials only, never labor. A line stamped
 *    `taxable === false` is left out too; a tax-exempt CUSTOMER (the
 *    estimate's own checkbox) zeroes the whole thing. Only an explicit false
 *    excludes, so lines saved before migration 336 (NULL) and anything
 *    unmatched stay taxed.
 *  - WHO decides `taxable` matters. It is FleetSuite's own rule, stamped by
 *    the caller via resolveLineTaxability (src/lib/line-taxability.ts):
 *    NetSuite Service items untaxed, every other type taxed, an admin's
 *    per-part override (netsuite_parts.taxable_override) winning over both.
 *    It is NOT NetSuite's item Taxable box. Migration 252 used that box and
 *    PR #984 removed it: the box is not maintained in this account, and a
 *    Sep 2026 quote came out with $6,848.61 of ordinary parts excluded and
 *    $175 of freight as the only taxed line, while NetSuite's invoice taxed
 *    all of it. `netsuite_parts.is_taxable` still mirrors the box for
 *    reference and nothing reads it for money. The push sends each line's
 *    flag to NetSuite so the invoice follows this rule, not the box.
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
 *  - A discount (migration 342) comes off the whole job after labor and
 *    before tax; see discountSplit. `subtotal` stays the parts total BEFORE
 *    the discount and `discount_amount` is reported on its own, so
 *    grand_total = subtotal + labor_total - discount_amount + tax_amount.
 *    A dollar discount on a fleet estimate is for the whole order.
 *  - A LINE discount (migration 350, see lineMoney) comes off its own line,
 *    so `subtotal` is the parts AFTER line discounts; line_discount_total
 *    reports how much they came to. The whole-job discount then applies on
 *    top of that.
 */

import { isLineTaxable } from './line-taxability';

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

/**
 * A discount the rep typed on the estimate (migration 342): a percent of the
 * whole job, or a dollar amount off the whole job. NULL = no discount.
 */
export type EstimateDiscount = { type: 'percent' | 'amount'; value: number } | null;

/** Read a discount off a request or an estimate row; anything unusable is none. */
export function normalizeDiscount(type: unknown, value: unknown): EstimateDiscount {
  if (type !== 'percent' && type !== 'amount') return null;
  const n = Math.round((parseFloat(String(value ?? '')) || 0) * 100) / 100;
  if (!(n > 0)) return null;
  return { type, value: type === 'percent' ? Math.min(n, 100) : n };
}

/** "Discount (10%)" / "Discount": the label documents and NetSuite share. */
export function discountLabel(type: unknown, value: unknown): string {
  const d = normalizeDiscount(type, value);
  return d?.type === 'percent' ? `Discount (${+d.value.toFixed(2)}%)` : 'Discount';
}

/**
 * The dollars a discount takes off, and how they split between taxed and
 * untaxed money.
 *
 * The discount comes off the WHOLE job (parts + labor, Craig 2026-10-05),
 * so it is spread over taxed and untaxed dollars in proportion. The taxed
 * share is what lowers the sales tax (Missouri taxes the price after a
 * seller's discount), and it is also exactly what the push sends to
 * NetSuite as a taxed discount line, with the rest as an untaxed one, so
 * NetSuite's tax comes out the same as ours.
 *
 *  - base: the job before the discount (parts subtotal + labor).
 *  - taxedBase: the part of `base` on taxed lines (never labor).
 *
 * A percent is rounded to the cent; a dollar amount is capped at the base,
 * so a discount can never take the job below $0.
 */
export function discountSplit(base: number, taxedBase: number, discount: EstimateDiscount): {
  amount: number; taxedPortion: number; untaxedPortion: number;
} {
  const cleanBase = Math.round(base * 100) / 100;
  if (!discount || !(cleanBase > 0)) return { amount: 0, taxedPortion: 0, untaxedPortion: 0 };
  const raw = discount.type === 'percent'
    ? roundCentsHalfEven(cleanBase * discount.value / 100)
    : discount.value;
  const amount = Math.round(Math.min(Math.max(raw, 0), cleanBase) * 100) / 100;
  const share = Math.min(Math.max(taxedBase, 0), cleanBase) / cleanBase;
  const taxedPortion = roundCentsHalfEven(amount * share);
  const untaxedPortion = Math.round((amount - taxedPortion) * 100) / 100;
  return { amount, taxedPortion, untaxedPortion };
}

/**
 * One line's money on a fleet estimate (units = vehicle count): the full
 * amount, its own discount (migration 350), and what is left.
 *
 * A line discount is a percent of that line, or dollars off that line's
 * WHOLE amount (all vehicles), capped at the line so it never goes below
 * $0. It is a separate figure, not a lower price: the document shows it as
 * a row under the part and the push sends a NetSuite discount line right
 * below the part, so NetSuite tracks it. Its tax follows the part's.
 */
export function lineMoney(line: any, units: unknown = 1): { gross: number; discount: number; net: number } {
  const n = normalizeVehicleCount(units);
  const gross = (parseFloat(line?.quantity || 0) || 0) * n * (parseFloat(line?.unit_price || 0) || 0);
  const d = normalizeDiscount(line?.discount_type, line?.discount_value);
  if (!d || !(gross > 0)) return { gross, discount: 0, net: gross };
  const raw = d.type === 'percent' ? roundCentsHalfEven(gross * d.value / 100) : d.value;
  const discount = Math.round(Math.min(raw, gross) * 100) / 100;
  return { gross, discount, net: gross - discount };
}

/** Price per unit after the line's own discount: what it earns, for margins. */
export function netUnitPrice(line: any, units: unknown = 1): number {
  const qty = (parseFloat(line?.quantity || 0) || 0) * normalizeVehicleCount(units);
  return qty > 0 ? lineMoney(line, units).net / qty : (parseFloat(line?.unit_price || 0) || 0);
}

/** A line's discount as estimate_line_items stores it (migration 350). */
export function lineDiscountColumns(line: any, units: unknown = 1) {
  const d = normalizeDiscount(line?.discount_type, line?.discount_value);
  return {
    discount_type: d?.type ?? null,
    discount_value: d?.value ?? null,
    discount_amount: lineMoney(line, units).discount,
  };
}

export function computeTotals(
  lines: any[],
  taxRate: number,
  taxExempt: boolean,
  laborRate: number,
  laborHoursOverride: number | null,
  vehicleCount: unknown = 1,
  discount: EstimateDiscount = null,
) {
  const units = normalizeVehicleCount(vehicleCount);
  const qtyOf = (l: any) => (parseFloat(l.quantity || 0) || 0) * units;
  // Parts after each line's own discount (migration 350).
  const subtotal = lines.reduce((sum: number, l: any) => sum + lineMoney(l, units).net, 0);
  const lineDiscountTotal = lines.reduce((sum: number, l: any) => sum + lineMoney(l, units).discount, 0);
  const autoLaborHours = lines.reduce((sum: number, l: any) => sum + (parseFloat(l.labor_hours || 0) * qtyOf(l)), 0);
  const effectiveLaborHours = laborHoursOverride !== null && laborHoursOverride !== undefined ? laborHoursOverride : autoLaborHours;
  const laborTotal = effectiveLaborHours * laborRate;
  // Parts/materials only (never labor, never a line stamped non-taxable),
  // taxed line by line, each rounded to cents, exactly as NetSuite books it.
  // The line amount here is the FLEET amount (qty × units) because that is
  // the quantity the sales order will carry.
  const taxedBase = lines.reduce((sum: number, l: any) => (
    isLineTaxable(l) ? sum + lineMoney(l, units).net : sum
  ), 0);
  const disc = discountSplit(subtotal + laborTotal, taxedBase, discount);
  // The discount's taxed share is one more line with its own rounded tax
  // (a negative one), the same way NetSuite books the taxed discount line.
  // A line discount on a taxed part is the same: its own negative tax line.
  const lineTax = lines.reduce((sum: number, l: any) => {
    if (!isLineTaxable(l)) return sum;
    const m = lineMoney(l, units);
    return sum + roundCentsHalfEven(m.gross * taxRate) - roundCentsHalfEven(m.discount * taxRate);
  }, 0);
  const taxAmount = taxExempt ? 0 : lineTax - roundCentsHalfEven(disc.taxedPortion * taxRate);
  const grandTotal = subtotal + laborTotal - disc.amount + taxAmount;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    labor_hours: Math.round(autoLaborHours * 100) / 100,
    labor_total: Math.round(laborTotal * 100) / 100,
    discount_amount: disc.amount,
    discount_taxed: disc.taxedPortion,
    line_discount_total: Math.round(lineDiscountTotal * 100) / 100,
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
