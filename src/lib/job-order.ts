/**
 * Job Order — a sales order printed as a shop pick ticket, with no money
 * on it (owner ask, 2026-10-09: "the same information as a sales order but
 * called a job order and printed without pricing"). The data comes live
 * from NetSuite via /api/netsuite/job-order/[id]; the PDF is built in the
 * browser by job-order-pdf.ts.
 *
 * This file holds the shared shape plus the SuiteQL row mapping, kept pure
 * so the route and the tests share it. Rates, amounts and totals are never
 * selected, so they cannot leak onto the printout.
 */

export interface JobOrderLine {
  partNumber: string;
  description: string;
  /** null on a description-only line (NetSuite "Description" items). */
  quantity: number | null;
}

export interface JobOrderData {
  id: string;
  soNumber: string;
  orderDate: string | null;
  customer: string | null;
  poNumber: string | null;
  vin: string | null;
  memo: string | null;
  status: string | null;
  salesRep: string | null;
  shipDate: string | null;
  shipMethod: string | null;
  shipTo: string | null;
  lines: JobOrderLine[];
}

// Item types that only carry money (or close a group) — nothing to pick.
const SKIPPED_ITEM_TYPES = new Set(['Subtotal', 'Discount', 'Markup', 'EndGroup', 'Payment']);

/** SuiteQL transactionline rows → printable lines. Quantity is stored
 *  negative on sales transactions, so it is shown as its absolute value. */
export function jobOrderLinesFromRows(rows: any[]): JobOrderLine[] {
  const out: JobOrderLine[] = [];
  for (const r of rows || []) {
    const type = String(r.item_type || '');
    if (SKIPPED_ITEM_TYPES.has(type)) continue;
    const description = String(r.description || r.display_name || '').trim();
    const partNumber = String(r.part_number || '').trim();
    const rawQty = parseFloat(r.quantity ?? '');
    const quantity = type === 'Description' || !Number.isFinite(rawQty) ? null : Math.abs(rawQty);
    if (!partNumber && !description) continue;
    if (quantity === 0 && type !== 'Description') continue;
    out.push({ partNumber, description, quantity });
  }
  return out;
}

/** BUILTIN.DF comes back type-prefixed ("Sales Order : Pending Fulfillment"). */
export function stripStatusPrefix(label: string | null | undefined): string | null {
  const s = String(label || '').replace(/^[^:]+:\s*/, '').trim();
  return s || null;
}
