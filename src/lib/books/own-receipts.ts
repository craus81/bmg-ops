import type { SupabaseClient } from '@supabase/supabase-js';
import type { SaveResult } from './own-invoices';

/**
 * Books' own copy of each Receive on the Receiving page (migration 435;
 * owner decision 2026-10-24, thread "Replacing NetSuite with FleetSuite",
 * "Shared bills"; docs/books.md "FleetSuite's own bills and receipts").
 *
 * A tap of Receive records one po_receipts row per line received and asks
 * NetSuite for an item receipt made from the PO (/api/po-receipts). When
 * NetSuite won't take it, the rows go on Receiving's list to enter in
 * NetSuite by hand. Either way Books keeps its own copy of the Receive,
 * worked out from what FleetSuite knows:
 *
 *   - its lines are what was received, each at the price FleetSuite's copy
 *     of the PO (netsuite_vendor_po_lines) has for that line;
 *   - its date is the one FleetSuite gave NetSuite;
 *   - it's keyed by the Receive's first po_receipts row, and carries
 *     NetSuite's id for the item receipt when NetSuite took it, or what
 *     NetSuite said when it didn't.
 *
 * The check (src/lib/books/own-receipt-check.ts) puts each copy next to
 * NetSuite's item receipt as the copy of its stock moves has it. Nothing is
 * written to NetSuite.
 *
 * Saving never stops a Receive: the parts are in either way, so a copy that
 * can't be saved is logged and left.
 */

export type ReceiptUnknown = 'prices';

export interface OwnReceiptLine {
  lineNo: number;
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number;
  /** The PO line's price as FleetSuite's copy of the PO has it; null when it has none. */
  rate: number | null;
  poLineId: string | null;
  /** FleetSuite's own row for the line on Receiving. */
  poReceiptId: string | null;
}

export interface OwnReceipt {
  receiptKey: string;
  netsuiteId: string | null;
  netsuiteNumber: string | null;
  poId: string | null;
  poNumber: string | null;
  vendorId: string | null;
  vendorName: string | null;
  /** 'YYYY-MM-DD', the date FleetSuite gave NetSuite. */
  receiveDate: string;
  netsuiteError: string | null;
  lines: OwnReceiptLine[];
  unknowns: ReceiptUnknown[];
  madeBy: string | null;
}

/** What the Receive knows once NetSuite has answered, and its po_receipts rows are in. */
export interface MadeReceipt {
  /** The Receive's po_receipts rows, in the order it received them. */
  rows: Array<{
    id: string | null;
    lineId: string | null;
    itemId: string | null;
    itemNumber: string | null;
    description: string | null;
    quantity: number;
    /** The PO line's price as FleetSuite's copy of the PO has it. */
    rate: number | string | null;
  }>;
  netsuiteId?: string | null;
  netsuiteNumber?: string | null;
  netsuiteError?: string | null;
  po: { netsuiteId: string | number | null; number: string | null; vendorId: string | number | null; vendorName: string | null };
  receiveDate: string;
  madeBy?: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numericId = (v: unknown): string | null => (v !== null && v !== undefined && /^\d+$/.test(String(v).trim()) ? String(v).trim() : null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string | null => {
  const t = v === null || v === undefined ? '' : String(v).trim();
  return t || null;
};

/** Books' own copy of a Receive, keyed by its first po_receipts row; null when there's no row to key it by. Pure. */
export function workOutOwnReceipt(made: MadeReceipt): OwnReceipt | null {
  const rows = made.rows.filter((r) => Number.isFinite(r.quantity) && r.quantity > 0);
  const key = rows[0]?.id;
  if (!key || !UUID_RE.test(key)) return null;
  const lines = rows.map((r, i): OwnReceiptLine => ({
    lineNo: i + 1,
    itemId: numericId(r.itemId),
    itemNumber: text(r.itemNumber),
    description: text(r.description),
    quantity: r.quantity,
    rate: num(r.rate),
    poLineId: text(r.lineId),
    poReceiptId: r.id && UUID_RE.test(r.id) ? r.id : null,
  }));
  const netsuiteId = numericId(made.netsuiteId);
  return {
    receiptKey: key,
    netsuiteId,
    netsuiteNumber: text(made.netsuiteNumber),
    poId: numericId(made.po.netsuiteId),
    poNumber: text(made.po.number),
    vendorId: numericId(made.po.vendorId),
    vendorName: text(made.po.vendorName),
    receiveDate: made.receiveDate,
    netsuiteError: netsuiteId ? null : text(made.netsuiteError)?.slice(0, 500) ?? null,
    lines,
    unknowns: lines.some((l) => l.rate === null) ? ['prices'] : [],
    madeBy: made.madeBy ?? null,
  };
}

/** The copy as gl_own_receipt_save takes it. */
export function receiptPayload(own: OwnReceipt): Record<string, unknown> {
  return {
    receipt_key: own.receiptKey,
    netsuite_id: own.netsuiteId,
    netsuite_number: own.netsuiteNumber,
    po_netsuite_id: own.poId,
    po_number: own.poNumber,
    vendor_netsuite_id: own.vendorId,
    vendor_name: own.vendorName,
    receive_date: own.receiveDate,
    netsuite_error: own.netsuiteError,
    unknowns: own.unknowns,
    made_by: own.madeBy,
    lines: own.lines.map((l) => ({
      line_no: l.lineNo,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      po_line_id: l.poLineId,
      po_receipt_id: l.poReceiptId,
    })),
  };
}

/**
 * Saves Books' own copy of a Receive. Never throws: the parts are in whatever happens here, so a copy that can't be
 * made is logged and the Receive goes on.
 */
export async function saveOwnReceipt(service: SupabaseClient, made: MadeReceipt): Promise<SaveResult> {
  const own = workOutOwnReceipt(made);
  if (!own) return { saved: false, reason: 'No receipt row to keep it by' };
  try {
    const { data, error } = await service.rpc('gl_own_receipt_save', { p: receiptPayload(own) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of the receipt on ${own.poNumber ?? 'a PO'} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
