/**
 * Copy from… on a new sales order (Craig, 2026-11-05, thread "Invoice
 * vehicles straight from FleetSuite"): bring an old sales order, invoice or
 * estimate's lines onto the form at TODAY's prices, so a repeat job for the
 * same van type starts filled in. Matched by NetSuite item id, then by item
 * number, never by words (the Copy to new estimate rule). Labor lines come
 * too, with their hours, priced at the item's catalog price or else the shop
 * labor rate. Discounts are left off, and parts the catalog no longer sells
 * are listed so the person can pick a replacement.
 *
 * Pure, so the route and its test agree.
 */

import { isDiscountLine, isLaborLine, nsItemNumber, type NetsuiteSourceDoc } from '@/lib/netsuite-estimate-copy';
import { MAX_LINES, NOT_BILLABLE_TYPES, type NewInvoiceItem } from '@/lib/new-invoice';

export interface CopiedLine extends NewInvoiceItem {
  quantity: number;
}

export interface SalesOrderCopy {
  lines: CopiedLine[];
  /** Old lines with no item FleetSuite still sells, as "ITEM: description". */
  missed: string[];
  discountLines: number;
}

export function copyLinesForSalesOrder(
  doc: NetsuiteSourceDoc,
  catalog: { byId: Map<string, NewInvoiceItem>; byNumber: Map<string, NewInvoiceItem> },
  laborRate: number,
): SalesOrderCopy {
  const lines: CopiedLine[] = [];
  const missed: string[] = [];
  let discountLines = 0;
  for (const l of doc.lines) {
    if (!l.itemNumber && !l.itemNetsuiteId) continue;
    if (isDiscountLine(l)) { discountLines++; continue; }
    const number = nsItemNumber(l.itemNumber);
    const item = (l.itemNetsuiteId ? catalog.byId.get(String(l.itemNetsuiteId)) : undefined)
      ?? (number ? catalog.byNumber.get(number) : undefined);
    if (!item || (item.itemType && NOT_BILLABLE_TYPES.has(item.itemType))) {
      missed.push([l.itemNumber, l.description && l.description !== l.itemNumber ? l.description : null].filter(Boolean).join(': ') || 'Item');
      continue;
    }
    const quantity = l.quantity !== null && Math.abs(l.quantity) > 0 ? Math.abs(l.quantity) : 1;
    const price = item.price !== null && item.price > 0 ? item.price : isLaborLine(l) ? laborRate : item.price;
    lines.push({ ...item, description: (l.description || '').trim() || item.description, price, quantity });
    if (lines.length >= MAX_LINES) break;
  }
  return { lines, missed, discountLines };
}
