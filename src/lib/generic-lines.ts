/**
 * Generic parts (Miscellaneous and anything else ticked "Generic part" on the
 * Parts page) are one catalog item standing in for many different things.
 * Grouping them by part number, the way real parts are, added three
 * different Misc lines into one row of 6 called "Miscellaneous", so nobody
 * could tell what to order (Craig, 2026-10-31, EST-2610-076).
 *
 * So a generic part is tracked per LINE, by the description typed on it:
 * each line is its own row, its own purchase request, its own PO line, and
 * is received on its own. It is never reserved from the shelf: there is no
 * shelf stock of "Miscellaneous". Its state comes from its requests:
 *   received (at Receiving, or "Got it" on the job card) → reserved
 *   ordered on a PO                                       → waiting
 *   anything else                                         → short
 *
 * Pure and client-safe; the catalog flag is read by `loadGenericItems`
 * in generic-lines-server.ts.
 */

/** Matching form of a line description: case, spacing and a kit tag
 *  ("[Rack R-12]", added on the sales order) don't make it a different line. */
export function genericDescKey(desc: string | null | undefined): string {
  return String(desc || '')
    .replace(/\s*\[(?:Rack [^\]]*|Hitch kit)\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Same generic line? The sales order carries "description — notes" where
 * the estimate has just the description, so one may extend the other.
 */
export function sameGenericLine(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = genericDescKey(a);
  const y = genericDescKey(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y} — `) || y.startsWith(`${x} — `);
}

/** Row key for a generic line: unique per item + description. */
export function genericLineKey(itemNumber: string, desc: string | null | undefined): string {
  return `${itemNumber}::${genericDescKey(desc)}`;
}

export interface GenericLineInput {
  description: string | null | undefined;
  quantity: number;
}

export interface GenericLine {
  key: string;
  description: string | null;
  needed: number;
}

/**
 * One row per distinct description, in the order the lines came. Two lines
 * with the same description are the same thing, so they add up.
 */
export function groupGenericLines(itemNumber: string, lines: GenericLineInput[]): GenericLine[] {
  const out: GenericLine[] = [];
  for (const l of lines) {
    const qty = Math.abs(Number(l.quantity) || 0);
    if (qty <= 0) continue;
    const desc = String(l.description || '').trim() || null;
    const hit = out.find(o => o.key === genericLineKey(itemNumber, desc));
    if (hit) hit.needed += qty;
    else out.push({ key: genericLineKey(itemNumber, desc), description: desc, needed: qty });
  }
  return out;
}

export interface GenericRequest {
  id?: string;
  item_number: string;
  description: string | null;
  quantity: number | string;
  status: string;
  received_at?: string | null;
  ordered_po_id?: string | null;
}

export interface GenericPoLine {
  po_id: string;
  item_number: string | null;
  description: string | null;
  quantity_received: number | string | null;
}

/**
 * How much of a request has arrived. "Got it" (received_at) means all of
 * it. Otherwise its PO's line for the same thing, matched by description,
 * says — that line was made for this request alone (create-po keeps generic
 * requests apart), whether it was checked in at Receiving or in NetSuite.
 * A PO with just one line of the item needs no description match.
 */
export function requestReceivedQty(req: GenericRequest, poLines: GenericPoLine[]): number {
  const qty = Math.max(0, Number(req.quantity) || 0);
  if (req.received_at) return qty;
  if (req.status !== 'ordered' || !req.ordered_po_id) return 0;
  const sameItem = poLines.filter(l => l.po_id === req.ordered_po_id
    && String(l.item_number || '').toUpperCase() === req.item_number.toUpperCase());
  const line = sameItem.find(l => sameGenericLine(l.description, req.description))
    || (sameItem.length === 1 ? sameItem[0] : undefined);
  if (!line) return 0;
  return Math.min(qty, Math.max(0, Number(line.quantity_received) || 0));
}

export interface GenericLineStatus {
  requested: number;
  ordered: number;
  received: number;
  short: number;
  state: 'reserved' | 'waiting' | 'short';
  /** Request ids behind this line, so "Got it" can mark them. */
  requestIds: string[];
}

/**
 * A generic line's state from the requests whose description matches it.
 * Pending counts as requested (display only, like real parts); ordered and
 * received count toward covering the line.
 */
export function genericLineStatus(
  line: { needed: number; description: string | null },
  requests: GenericRequest[],
  poLines: GenericPoLine[],
): GenericLineStatus {
  let requested = 0;
  let ordered = 0;
  let received = 0;
  const requestIds: string[] = [];
  for (const r of requests) {
    if (r.status === 'cancelled') continue;
    if (!sameGenericLine(line.description, r.description)) continue;
    if (r.id) requestIds.push(r.id);
    const qty = Math.max(0, Number(r.quantity) || 0);
    const got = requestReceivedQty(r, poLines);
    received += got;
    if (r.status === 'ordered' || r.received_at) ordered += qty - got;
    else requested += qty;
  }
  received = Math.min(received, line.needed);
  ordered = Math.min(ordered, Math.max(0, line.needed - received));
  const short = Math.max(0, line.needed - received - ordered);
  const state = line.needed > 0 && received >= line.needed ? 'reserved' : short === 0 ? 'waiting' : 'short';
  return { requested, ordered, received, short, state, requestIds };
}
