import { suiteqlQueryAll } from '@/lib/netsuite';
import { centsOf } from './invoice-check';

/**
 * Shipping and handling NetSuite adds to an invoice FleetSuite makes (NetSuite
 * Exit Checklist, "Gaps in what's built"; thread "Replacing NetSuite with
 * FleetSuite", 2026-11-03; docs/books.md "Shipping and handling NetSuite
 * adds").
 *
 * FleetSuite never bills shipping: NetSuite adds it to the invoice from the
 * invoice's header, the shipping method and cost of the sales order it's made
 * from, or the customer's own shipping method. NetSuite keeps it on lines of
 * the invoice whose item is a shipping item (type ShipItem), and the ledger
 * mirror copies those with the rest, so the check found a line on NetSuite's
 * invoice that FleetSuite's own copy (src/lib/books/own-invoices.ts) didn't
 * bill, and the invoice posted from NetSuite's.
 *
 * Now, as soon as NetSuite has made an invoice, or FleetSuite has fixed one,
 * FleetSuite reads that invoice's shipping lines from NetSuite and its own
 * copy bills them as NetSuite charged them. FleetSuite doesn't tax them, as it
 * doesn't tax freight on quotes (owner decision 2026-10-01: Missouri doesn't
 * tax delivery charged on its own line); where NetSuite taxed one, the check
 * says so. A read that fails leaves the copy without them, as copies were
 * before, and the check says NetSuite's invoice has a line the copy doesn't.
 * Nothing is written to NetSuite.
 */

/** NetSuite's item type for shipping and handling. */
export const SHIP_ITEM_TYPE = 'ShipItem';

/** How long a read of the shipping waits for NetSuite: the invoice is made, and the billing screen is waiting. */
export const CHARGES_TIMEOUT_MS = 6000;

/** A shipping or handling line of NetSuite's invoice, as FleetSuite's own copy bills it. */
export interface ChargeLine {
  /** NetSuite's id for the shipping item. */
  itemId: string;
  itemNumber: string | null;
  description: string | null;
  quantity: null;
  rate: null;
  /** What NetSuite charged, in cents. */
  cents: number;
}

export type ChargesRead = { ok: true; lines: ChargeLine[] } | { ok: false; reason: string };

/** The shipping and handling lines of one NetSuite invoice, in the invoice's order. */
export function chargesQuery(invoiceId: string): string {
  if (!/^\d+$/.test(invoiceId)) throw new Error(`Not a NetSuite invoice id: ${invoiceId}`);
  return `
    SELECT tl.id AS line_id, tl.linesequencenumber AS line_no, tl.item, i.itemid AS item_number,
           tl.memo AS description, tl.netamount
    FROM transactionline tl
    JOIN item i ON i.id = tl.item
    WHERE tl.transaction = ${invoiceId}
      AND tl.mainline = 'F'
      AND tl.taxline = 'F'
      AND i.itemtype = '${SHIP_ITEM_TYPE}'
    ORDER BY tl.linesequencenumber, tl.id`;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * NetSuite's answer as the lines the copy bills: each at what NetSuite charged, its own amount the other way round
 * (a sale is negative in NetSuite), lines of nothing left out. Null when the answer can't be read whole, a line
 * without its item or an amount that isn't one: the copy doesn't take part of it.
 */
export function chargeLines(rows: unknown): ChargeLine[] | null {
  if (!Array.isArray(rows)) return null;
  const lines: ChargeLine[] = [];
  for (const row of rows) {
    const r = (row ?? {}) as Record<string, unknown>;
    const itemId = r.item !== null && r.item !== undefined && /^\d+$/.test(String(r.item).trim()) ? String(r.item).trim() : null;
    const net = centsOf(r.netamount);
    if (!itemId || net === null) return null;
    if (net === 0) continue;
    lines.push({ itemId, itemNumber: text(r.item_number), description: text(r.description), quantity: null, rate: null, cents: -net });
  }
  return lines;
}

/**
 * Reads the shipping and handling NetSuite put on an invoice. Never throws, and gives up after `timeoutMs`: the
 * invoice exists in NetSuite whatever happens here, and its copy is saved either way. An id that isn't one asks
 * NetSuite nothing (chargesQuery refuses it).
 */
export async function readInvoiceCharges(invoiceId: string, opts: { timeoutMs?: number } = {}): Promise<ChargesRead> {
  const timeoutMs = opts.timeoutMs ?? CHARGES_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rows = await Promise.race([
      suiteqlQueryAll(chargesQuery(invoiceId), 1000, { retries: 1 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`NetSuite didn't answer within ${timeoutMs / 1000} seconds`)), timeoutMs);
      }),
    ]);
    const lines = chargeLines(rows);
    return lines ? { ok: true, lines } : { ok: false, reason: "NetSuite's answer couldn't be read" };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err).slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The lines an invoice bills once NetSuite has said what shipping it added: FleetSuite's own, less any shipping line
 * of them (FleetSuite's copy of a sales order keeps the order's), then NetSuite's shipping and handling as it
 * charged them.
 */
export function withCharges<L extends { itemId: string | null }>(
  billed: L[],
  charges: L[],
  typeOf: (itemId: string) => string | null | undefined,
): L[] {
  return [...billed.filter((l) => !l.itemId || typeOf(l.itemId) !== SHIP_ITEM_TYPE), ...charges];
}
