/**
 * Fulfill & Invoice from an estimate's sales order (Craig, 2026-10-21,
 * thread "Creating invoices from FleetSuite").
 *
 * A parts-only estimate becomes a sales order, and no vehicle, scan or
 * check-in ever touches it — so none of the other invoice paths (In-Shop
 * completion, the Invoicing page, the customer PO page) are used. This bills
 * the order straight from the estimate: office/admin only, always shipped
 * from BMG O'Fallon, partial shipments allowed (the rest stays open on the
 * sales order for another Fulfill & Invoice later).
 *
 * Pure, so the window can use it too; reading the order from NetSuite is
 * so-fulfill-invoice-read.ts. The route is /api/estimates/[id]/fulfill-invoice.
 */

/** NetSuite item types that move stock, so a line must be fulfilled before it is billed. */
export const SHIPPED_TYPES = new Set(['InvtPart', 'Assembly', 'Kit']);
/** Lines with no quantity of their own: shown, never billed by quantity. */
export const ADJUSTMENT_TYPES = new Set(['Discount', 'Markup']);
/** Layout lines: not shown, nothing to bill. */
export const LAYOUT_TYPES = new Set(['Subtotal', 'Description', 'Group', 'EndGroup']);

export interface SoBillingLine {
  /** transactionline.linesequencenumber — the transforms' orderLine and createInvoiceFromSO's key. */
  lineSeq: number;
  /** transactionline.id — what the books copies call the sales order line id. */
  lineId: string;
  itemId: string;
  itemNumber: string;
  description: string;
  itemType: string;
  ordered: number;
  fulfilled: number;
  billed: number;
  rate: number | null;
  amount: number | null;
  /** On hand at O'Fallon; null when NetSuite couldn't say. Shipped lines only. */
  onHand: number | null;
  closed: boolean;
}

export interface SoBillingRead {
  status: string;
  soNumber: string;
  customerName: string | null;
  poNumber: string | null;
  lines: SoBillingLine[];
}

const four = (x: number) => Math.round(x * 10_000) / 10_000;

/** What's still open on a line: to bill, and (for stock lines) to ship. */
export function openOn(line: SoBillingLine): { toBill: number; toShip: number; shippedNotBilled: number } {
  if (line.closed || ADJUSTMENT_TYPES.has(line.itemType)) return { toBill: 0, toShip: 0, shippedNotBilled: 0 };
  const toBill = Math.max(0, four(line.ordered - line.billed));
  if (!SHIPPED_TYPES.has(line.itemType)) return { toBill, toShip: 0, shippedNotBilled: 0 };
  const toShip = Math.max(0, four(line.ordered - line.fulfilled));
  const shippedNotBilled = Math.max(0, four(line.fulfilled - line.billed));
  return { toBill, toShip, shippedNotBilled };
}

/** The quantity the window starts each line at: everything open, a stock line capped at what's on hand. */
export function defaultBillNow(line: SoBillingLine): number {
  const { toBill, toShip, shippedNotBilled } = openOn(line);
  if (!SHIPPED_TYPES.has(line.itemType)) return toBill;
  const canShip = line.onHand === null ? toShip : Math.min(toShip, Math.max(0, line.onHand));
  return Math.min(toBill, four(shippedNotBilled + canShip));
}

export type FulfillInvoicePlan =
  | {
    ok: true;
    /** Lines to ship now (stock lines whose billed units aren't already shipped). */
    shipLines: { orderLine: number; quantity: number }[];
    /** Every other line, sent itemReceive:false so the transform doesn't ship it in full. */
    excludeOrderLines: number[];
    /** orderLine → quantity to bill; empty when billing the whole rest of the order. */
    billLines: Record<number, number>;
    /** True when this bills everything left: the invoice then comes off the order whole (discount lines included). */
    wholeRest: boolean;
    units: number;
    /** What ships, for the books copy of the fulfillment. */
    shipped: { salesOrderLineId: string; quantity: number }[];
  }
  | { ok: false; error: string };

/**
 * Works out the fulfillment and invoice for "bill these quantities now".
 * A stock line's units are taken first from what's already shipped but not
 * billed, then shipped now. Refuses anything over what's open.
 */
export function planFulfillInvoice(lines: SoBillingLine[], billNow: Record<number, number>): FulfillInvoicePlan {
  const bySeq = new Map(lines.map(l => [l.lineSeq, l]));
  const billLines: Record<number, number> = {};
  const shipLines: { orderLine: number; quantity: number }[] = [];
  const shipped: { salesOrderLineId: string; quantity: number }[] = [];
  let units = 0;

  for (const [seqText, qtyRaw] of Object.entries(billNow)) {
    const seq = Number(seqText);
    const qty = four(Number(qtyRaw));
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: 'Quantities must be zero or more' };
    if (qty === 0) continue;
    const line = bySeq.get(seq);
    if (!line) return { ok: false, error: `Line ${seq} is not on the sales order` };
    const label = line.itemNumber || `line ${seq}`;
    if (line.closed) return { ok: false, error: `${label} is closed on the sales order` };
    if (ADJUSTMENT_TYPES.has(line.itemType)) return { ok: false, error: `${label} is a ${line.itemType.toLowerCase()} line; it goes on the invoice that bills the rest of the order` };
    const { toBill, shippedNotBilled } = openOn(line);
    if (qty > toBill + 1e-9) return { ok: false, error: `${label}: billing ${qty} but only ${toBill} is still open` };
    billLines[seq] = qty;
    units += qty;
    if (SHIPPED_TYPES.has(line.itemType)) {
      const ship = four(qty - shippedNotBilled);
      if (ship > 0) {
        shipLines.push({ orderLine: seq, quantity: ship });
        shipped.push({ salesOrderLineId: line.lineId, quantity: ship });
      }
    }
  }
  if (units === 0) return { ok: false, error: 'Nothing to invoice: every quantity is 0' };

  const wholeRest = lines.every(l => {
    const { toBill } = openOn(l);
    return toBill === 0 || (billLines[l.lineSeq] ?? 0) >= toBill - 1e-9;
  });
  const hasAdjustment = lines.some(l => ADJUSTMENT_TYPES.has(l.itemType) && !l.closed);
  if (hasAdjustment && !wholeRest) {
    return { ok: false, error: 'This order has a discount line, so it can only be invoiced all at once from here: bill everything that is left, or ship part of it first and invoice when the rest is in.' };
  }

  const shipping = new Set(shipLines.map(l => l.orderLine));
  const excludeOrderLines = lines
    .filter(l => SHIPPED_TYPES.has(l.itemType) && !shipping.has(l.lineSeq) && openOn(l).toShip > 0)
    .map(l => l.lineSeq)
    .sort((a, b) => a - b);

  return {
    ok: true,
    shipLines: shipLines.sort((a, b) => a.orderLine - b.orderLine),
    excludeOrderLines,
    billLines: wholeRest ? {} : billLines,
    wholeRest,
    units,
    shipped,
  };
}
