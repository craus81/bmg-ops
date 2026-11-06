/**
 * "Adjust & invoice" in the In-Shop completion window (Craig, 2026-11-05):
 * when a removal ran long or the job took more vinyl, change the sales
 * order's quantities and prices, or add lines, then bill it — without
 * leaving the window.
 *
 * Pure: turns what the person typed into the edit PATCH
 * /api/sales-orders/[id] takes (planned again on the server by
 * planSalesOrderEdit, which enforces NetSuite's rules), and works out the
 * new subtotal to show before saving. Only quantity, price and new lines —
 * header fields, close and remove stay on the sales order page.
 */

import { lineAllows, type SoLine, type SoLineEdit, type SoNewLine } from './sales-order-edit';

export interface AdjustLineDraft {
  quantity: string;
  rate: string;
}

export interface AdjustNewDraft {
  key: number;
  itemId: string;
  itemNumber: string;
  description: string;
  quantityText: string;
  rateText: string;
}

export interface AdjustEdit {
  lines: SoLineEdit[];
  add: SoNewLine[];
  /** Plain sentences, one per problem; nothing is sent while any exist. */
  errors: string[];
  count: number;
  /** Subtotal of the order as it will be after the edit (before tax). */
  subtotal: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const cents = (n: number) => Math.round(n * 100);

export function qtyText(n: number): string {
  return String(round2(n));
}

/** Starting drafts: every line as NetSuite has it now. */
export function startDrafts(lines: SoLine[]): Record<number, AdjustLineDraft> {
  return Object.fromEntries(lines.map(l => [l.line, {
    quantity: qtyText(l.quantity),
    rate: l.rate == null ? '' : String(l.rate),
  }]));
}

/** A quantity under what already shipped or billed, said plainly; else null. */
export function adjustLineProblem(l: SoLine, d: AdjustLineDraft | undefined): string | null {
  if (!d || !lineAllows(l).quantity) return null;
  const q = parseFloat(d.quantity);
  if (!Number.isFinite(q)) return 'Enter a quantity';
  const floor = Math.max(l.quantityShipped, l.quantityBilled);
  if (q < floor) return `${qtyText(floor)} already ${l.quantityBilled >= floor ? 'billed' : 'shipped'}`;
  if (q <= 0) return 'Use the sales order page to remove a line';
  return null;
}

/**
 * The edit to send. `seeMoney` false leaves every price as it is (the
 * server hides prices from people without See prices, so there is nothing
 * to compare against).
 */
export function buildAdjustEdit(
  lines: SoLine[],
  drafts: Record<number, AdjustLineDraft>,
  added: AdjustNewDraft[],
  seeMoney: boolean,
): AdjustEdit {
  const out: SoLineEdit[] = [];
  const errors: string[] = [];
  let subtotal = 0;

  for (const l of lines) {
    const d = drafts[l.line];
    const can = lineAllows(l);
    let q = l.quantity;
    let r = l.rate;
    const e: SoLineEdit = { line: l.line };
    if (d && can.quantity) {
      const problem = adjustLineProblem(l, d);
      if (problem) errors.push(`${l.itemNumber}: ${problem.toLowerCase()}.`);
      else {
        const v = parseFloat(d.quantity);
        if (cents(v) !== cents(l.quantity)) { e.quantity = v; q = v; }
      }
    }
    if (d && can.price && seeMoney && d.rate.trim() !== '') {
      const v = parseFloat(d.rate);
      if (!Number.isFinite(v) || v < 0) errors.push(`${l.itemNumber}: enter a price.`);
      else if (r == null || cents(v) !== cents(r)) { e.rate = v; r = v; }
    }
    if (Object.keys(e).length > 1) out.push(e);
    // Changed lines are re-priced; the rest keep NetSuite's own amount
    // (discount and subtotal lines included).
    subtotal += e.quantity != null || e.rate != null ? q * (r ?? 0) : l.amount;
  }

  const add: SoNewLine[] = [];
  for (const n of added) {
    const q = parseFloat(n.quantityText);
    const r = parseFloat(n.rateText);
    if (!Number.isFinite(q) || q <= 0) { errors.push(`${n.itemNumber}: enter a quantity.`); continue; }
    if (!Number.isFinite(r) || r < 0) { errors.push(`${n.itemNumber}: enter a price.`); continue; }
    add.push({ itemId: n.itemId, itemNumber: n.itemNumber, description: n.description, quantity: q, rate: r });
    subtotal += q * r;
  }

  return { lines: out, add, errors, count: out.length + add.length, subtotal: round2(subtotal) };
}
