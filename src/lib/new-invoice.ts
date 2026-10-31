/**
 * New invoice from nothing (Craig, 2026-10-26, thread "Redesign order-to-cash
 * and procure-to-pay": "there's really no way to just create an invoice … from
 * nothing right now"). Pick a customer, type the lines, and FleetSuite makes a
 * standalone invoice in NetSuite (createDirectInvoice, no sales order), shipped
 * from O'Fallon, and Books keeps its own copy (made_from 'typed').
 *
 * Craig's answers 2026-10-27: any NetSuite item can go on it (parts, labor,
 * freight, discounts; a stock part comes off O'Fallon's stock when NetSuite
 * invoices it), and anyone with the Invoicing permission can make one.
 *
 * New sales order (Craig 2026-10-31, answers 1A 2A 3A 4B) uses the same lines,
 * tax and checks with `noun: 'sales order'` (src/lib/new-sales-order.ts).
 *
 * Pure, so the page and the route agree on the lines, the tax and the total.
 * Tax follows FleetSuite's own rule (src/lib/line-taxability.ts), the same one
 * Books uses: service items untaxed, everything else taxed, a discount taxed
 * like the line above it, nothing taxed for a tax-exempt customer.
 */

import { roundCentsHalfEven } from '@/lib/estimate-totals';
import { isPartTaxable } from '@/lib/line-taxability';

/** NetSuite item types a typed invoice can't bill: layout lines and groups. */
export const NOT_BILLABLE_TYPES = new Set(['Subtotal', 'Description', 'Group', 'EndGroup']);

export const MAX_LINES = 100;

export interface NewInvoiceItem {
  itemId: string;
  itemNumber: string;
  description: string;
  /** NetSuite item type ("InvtPart", "Service", "Discount", …); null when the catalog doesn't say. */
  itemType: string | null;
  /** The catalog's sales price; null when it has none. */
  price: number | null;
  taxableOverride: boolean | null;
}

/** A line as typed: a discount's price is the amount it takes off, typed as a positive number. */
export interface NewInvoiceLineDraft {
  itemId: string;
  itemNumber: string;
  itemType: string | null;
  taxableOverride: boolean | null;
  description: string;
  quantity: number;
  price: number;
}

export interface WorkedLine extends NewInvoiceLineDraft {
  isDiscount: boolean;
  /** What the line charges, a discount negative. */
  cents: number;
  taxable: boolean;
}

export interface WorkedInvoice {
  lines: WorkedLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** Plain-English reasons the invoice can't be made yet, one per problem. */
  problems: string[];
}

export const isDiscountType = (itemType: string | null | undefined) => itemType === 'Discount';

const cents = (dollars: number) => Math.round(roundCentsHalfEven(dollars) * 100);

/** One line's tax at a rate (a fraction), rounded half to even the way NetSuite and Books do. */
const lineTax = (lineCents: number, rate: number) => (rate > 0 ? cents((lineCents / 100) * rate) : 0);

/**
 * The invoice's lines, tax and total, and what stops it. `taxRate` is Settings → Sales Tax as a fraction;
 * `taxExempt` is the customer's tax-exempt flag; `noun` names the document in the problems (default "invoice").
 */
export function workOutNewInvoice(
  drafts: NewInvoiceLineDraft[],
  opts: { taxRate: number; taxExempt: boolean; hasCustomer: boolean; noun?: string },
): WorkedInvoice {
  const noun = opts.noun || 'invoice';
  const problems: string[] = [];
  if (!opts.hasCustomer) problems.push('Pick the customer.');
  if (drafts.length === 0) problems.push('Add at least one line.');
  if (drafts.length > MAX_LINES) problems.push(`${noun === 'invoice' ? 'An invoice' : `A ${noun}`} can have at most ${MAX_LINES} lines.`);

  const rate = opts.taxExempt ? 0 : Math.max(0, opts.taxRate || 0);
  const lines: WorkedLine[] = [];
  drafts.forEach((d, i) => {
    const name = d.itemNumber || `Line ${i + 1}`;
    const isDiscount = isDiscountType(d.itemType);
    if (d.itemType && NOT_BILLABLE_TYPES.has(d.itemType)) problems.push(`${name} is a ${d.itemType} item and can't be billed.`);
    if (!isDiscount && !(Number.isFinite(d.quantity) && d.quantity > 0)) problems.push(`${name}: enter a quantity above 0.`);
    if (!(Number.isFinite(d.price) && d.price > 0)) {
      problems.push(isDiscount ? `${name}: enter how much the discount takes off.` : `${name}: enter a price above $0.`);
    }
    if (isDiscount && i === 0) problems.push(`${name}: a discount goes under the line it takes money off.`);

    const lineCents = isDiscount ? -cents(d.price || 0) : cents((d.quantity || 0) * (d.price || 0));
    const above = lines[lines.length - 1];
    const taxable = isDiscount
      ? (above ? above.taxable : true)
      : isPartTaxable({ item_type: d.itemType, item_number: d.itemNumber, taxable_override: d.taxableOverride });
    lines.push({ ...d, isDiscount, cents: lineCents, taxable });
  });

  const subtotalCents = lines.reduce((s, l) => s + l.cents, 0);
  const taxCents = lines.reduce((s, l) => s + (l.taxable ? lineTax(l.cents, rate) : 0), 0);
  if (lines.length > 0 && subtotalCents <= 0) problems.push(`The ${noun} total has to be more than $0.`);
  return { lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, problems };
}

/**
 * The lines as NetSuite takes them (createDirectInvoice): a discount carries only its negative rate. The tax flag
 * goes the way the estimate push sends it (nsLineTaxField): an untaxed line says false, a taxed discount says true,
 * an ordinary taxed line says nothing; for a tax-exempt customer every line says false.
 */
export function netsuiteLines(worked: WorkedLine[], opts: { taxExempt: boolean }) {
  return worked.map(l => ({
    itemId: l.itemId,
    quantity: l.isDiscount ? 1 : l.quantity,
    rate: l.isDiscount ? l.cents / 100 : l.price,
    description: l.description.trim() || undefined,
    partNumber: l.itemNumber,
    taxable: opts.taxExempt || !l.taxable ? false : l.isDiscount ? true : undefined,
    ...(l.isDiscount ? { discountItem: true as const } : {}),
  }));
}

/** The lines as Books' copy takes them (saveOwnInvoice `billed`). */
export function booksLines(worked: WorkedLine[]) {
  return worked.map(l => l.isDiscount
    ? { itemId: l.itemId, itemNumber: l.itemNumber, description: l.description.trim() || null, quantity: null, rate: null, cents: l.cents }
    : { itemId: l.itemId, itemNumber: l.itemNumber, description: l.description.trim() || null, quantity: l.quantity, rate: l.price });
}

export const formatCents = (c: number) =>
  (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
