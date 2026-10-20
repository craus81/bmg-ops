import { matchRequest, type CatalogPart, type DraftLine } from '@/lib/paste-to-estimate';

/**
 * "Copy to new estimate" from a NetSuite invoice, sales order or estimate
 * (owner ask 2026-10-20: take the part numbers from an old transaction and
 * let FleetSuite supply today's pricing). The QuickBooks version is
 * src/lib/quickbooks-estimate-copy.ts; this one feeds the same review grid
 * under the same rules: nothing lands on the estimate until the rep ticks it,
 * and prices come from TODAY's catalog, never from the old document.
 *
 * NetSuite lines name NetSuite items, which ARE the catalog, so a line
 * matches by the item's internal id (then its number) or not at all. There
 * is no word matching: a part that's gone from the catalog is shown as a
 * custom line at $0, unticked (owner choice), rather than swapped for
 * something that reads alike.
 *
 * Two kinds of line are left off and counted instead: labor (the estimate
 * figures labor from its parts, so copying the old hours as a part line would
 * bill them twice) and discounts (an old deal is not today's price).
 */

export type NetsuiteCopyType = 'invoice' | 'salesOrder' | 'estimate';

export const NETSUITE_COPY_TYPES: readonly NetsuiteCopyType[] = ['invoice', 'salesOrder', 'estimate'];

export const NETSUITE_COPY_LABEL: Record<NetsuiteCopyType, string> = {
  invoice: 'Invoice',
  salesOrder: 'Sales Order',
  estimate: 'Estimate',
};

/** One line of the old NetSuite document, from whichever copy holds it. */
export interface NetsuiteSourceLine {
  itemNetsuiteId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}

export interface NetsuiteSourceDoc {
  number: string;
  typeLabel: string;
  date: string;
  lines: NetsuiteSourceLine[];
}

/** What was left off the grid on purpose, so the panel can say so. */
export interface NetsuiteCopySkipped {
  laborLines: number;
  laborHours: number;
  discountLines: number;
}

export interface NetsuiteCopyRequest {
  line: NetsuiteSourceLine;
  raw: string;
}

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** NetSuite shows sub-items as "Parent : Child"; the child is the item. */
export function nsItemNumber(v: unknown): string | null {
  const s = String(v ?? '').split(':').pop()!.trim().toUpperCase();
  return s || null;
}

/** Labor items, by the same word the labor resolver ranks on (src/lib/labor-item.ts). */
export const isLaborLine = (l: NetsuiteSourceLine): boolean => /LABOR/i.test(l.itemNumber || '');

/**
 * A discount line: a negative amount where the copy kept NetSuite's sign
 * (the invoice mirror's raw line), else a discount item by name — the sales
 * order and estimate copies store amounts unsigned.
 */
export const isDiscountLine = (l: NetsuiteSourceLine): boolean =>
  (l.amount !== null && l.amount < 0) || (l.rate !== null && l.rate < 0) || /DISCOUNT/i.test(l.itemNumber || '');

/** Row shapes from the three copies → one line shape. */
export function sourceLineFromRow(row: Record<string, any>): NetsuiteSourceLine {
  return {
    itemNetsuiteId: row.item_netsuite_id ?? row.item_external_id ?? null,
    itemNumber: nsItemNumber(row.item_number ?? row.item_name),
    description: row.description ? String(row.description).trim() || null : null,
    quantity: num(row.quantity),
    rate: num(row.rate ?? row.unit_price),
    amount: num(row.amount),
  };
}

/** Split the document into lines for the grid and lines left off on purpose. */
export function netsuiteDraftRequests(doc: NetsuiteSourceDoc): { requests: NetsuiteCopyRequest[]; skipped: NetsuiteCopySkipped } {
  const skipped: NetsuiteCopySkipped = { laborLines: 0, laborHours: 0, discountLines: 0 };
  const requests: NetsuiteCopyRequest[] = [];
  const typeWord = doc.typeLabel.toLowerCase();
  for (const l of doc.lines) {
    if (!l.itemNumber && !l.itemNetsuiteId) continue;
    if (isLaborLine(l)) {
      skipped.laborLines++;
      skipped.laborHours += Math.abs(l.quantity ?? 0);
      continue;
    }
    if (isDiscountLine(l)) { skipped.discountLines++; continue; }
    const qty = l.quantity !== null && l.quantity > 0 ? l.quantity : null;
    const was = qty !== null && l.rate !== null ? `${qty} × ${money(l.rate)}` : l.amount !== null ? money(l.amount) : 'no price';
    const label = [l.itemNumber, l.description && l.description !== l.itemNumber ? l.description : null].filter(Boolean).join(': ');
    requests.push({ line: l, raw: `${label || 'Item'} (${was} on ${typeWord} ${doc.number}, ${doc.date})` });
  }
  skipped.laborHours = Math.round(skipped.laborHours * 100) / 100;
  return { requests, skipped };
}

/** A catalog row as the copy reads it: the matcher's fields plus whether it's still sold. */
export type NetsuiteCatalogPart = CatalogPart & { is_active?: boolean | null };

/**
 * Match one line to the catalog: the same NetSuite item first, then the same
 * item number. Never by words.
 */
export function matchNetsuiteLine(q: NetsuiteCopyRequest, catalog: NetsuiteCatalogPart[]): DraftLine {
  const { line } = q;
  const request = {
    raw: q.raw,
    itemNumber: null,
    description: line.description || line.itemNumber || 'Item',
    quantity: line.quantity !== null && line.quantity > 0 ? line.quantity : null,
  };
  const byId = line.itemNetsuiteId ? catalog.find(p => String(p.netsuite_id ?? '') === String(line.itemNetsuiteId)) : undefined;
  const byNumber = !byId && line.itemNumber
    ? catalog.find(p => nsItemNumber(p.item_number) === line.itemNumber)
    : undefined;
  const part = byId || byNumber;
  const none: DraftLine = {
    request, part: null, confidence: 'none',
    signal: line.itemNumber ? `${line.itemNumber} isn't in today's catalog` : 'no catalog match',
    matchedText: null, score: null, unitPrice: null, laborHours: null,
  };
  if (!part) return none;
  if (part.is_active === false) return { ...none, signal: `${part.item_number} is inactive in the catalog` };
  const m = matchRequest({ ...request, itemNumber: part.item_number }, [part]);
  return {
    ...m,
    request,
    signal: byId ? `same NetSuite item, ${part.item_number}` : `item number ${part.item_number}`,
  };
}
