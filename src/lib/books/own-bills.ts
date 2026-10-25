import type { SupabaseClient } from '@supabase/supabase-js';
import { chicagoDate, type SaveResult } from './own-invoices';

/**
 * Books' own copy of each bill FleetSuite puts into NetSuite (migration 435;
 * owner decision 2026-10-24, thread "Replacing NetSuite with FleetSuite",
 * "Shared bills"; docs/books.md "FleetSuite's own bills and receipts").
 *
 * FleetSuite makes a bill three ways: Create Bill in NetSuite on an approved
 * vendor invoice (AP) or an approved installer payout, and Create bill on a
 * Parts Mail invoice. Right after NetSuite makes it, Books keeps its own
 * copy of what FleetSuite sent, worked out from what FleetSuite knows rather
 * than read back from NetSuite:
 *
 *   - a vendor invoice's or payout's bill is one expense line: the amount
 *     FleetSuite sent, to the account it sent (Subcontractors);
 *   - a Parts Mail bill is made from the invoice's purchase order, which
 *     NetSuite bills at the PO's prices, so its lines are what FleetSuite's
 *     copy of the PO (netsuite_vendor_po_lines, copied every two hours) still
 *     had to bill, each its open quantity at the PO's price, to the cent. The
 *     vendor's invoice total is kept beside them;
 *   - the date is the day FleetSuite made it, in Central time: FleetSuite
 *     sends no date, and NetSuite dates the bill that day.
 *
 * What FleetSuite can't work out is said so on the copy (unknowns) rather
 * than guessed: a PO its copy doesn't have, a line it has no price for. The
 * check (src/lib/books/own-bill-check.ts) puts each copy next to NetSuite's
 * bill. Nothing is written to NetSuite.
 *
 * Saving never stops a bill: the bill exists in NetSuite before the copy is
 * made, so a copy that can't be saved is logged and left.
 */

export type BillMadeFrom = 'vendor_invoice' | 'payout' | 'parts_mail';
export type BillUnknown = 'lines' | 'prices';

export interface OwnBillLine {
  lineNo: number;
  /** An expense line's account, NetSuite's id for it. */
  accountId: string | null;
  /** An item line's item, NetSuite's id for it. */
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  /** In whole cents; null when FleetSuite had no price for the line. */
  cents: number | null;
  poLineId: string | null;
}

export interface OwnBill {
  netsuiteId: string;
  netsuiteNumber: string | null;
  subsidiaryId: string | null;
  madeFrom: BillMadeFrom;
  madeFromId: string | null;
  vendorId: string | null;
  vendorName: string | null;
  referenceNo: string | null;
  /** 'YYYY-MM-DD', the day FleetSuite made it in Central time. */
  billDate: string;
  poId: string | null;
  poNumber: string | null;
  locationId: string | null;
  /** In whole cents, what the vendor's invoice said it came to; null when FleetSuite read none. */
  invoiceCents: number | null;
  lines: OwnBillLine[];
  unknowns: BillUnknown[];
  madeBy: string | null;
}

/** What FleetSuite's copy of a purchase order has for one of its lines. */
export interface PoCopyLine {
  line_id: string | null;
  item_netsuite_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: number | string | null;
  quantity_billed: number | string | null;
  rate: number | string | null;
  amount: number | string | null;
}

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
/** Dollars to whole cents, half away from zero (never -0), past the float error in a product like 1.005 × 1. */
export const toCents = (dollars: number) => {
  const cents = Number((Math.abs(dollars) * 100).toFixed(6));
  return (dollars < 0 ? -Math.round(cents) : Math.round(cents)) || 0;
};
/** A quantity to the four places the copy keeps. */
const fourPlaces = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * A Parts Mail bill's lines: each line of FleetSuite's copy of the PO with some still to bill, its open quantity at
 * the PO's price (the line's amount over its quantity when the copy has no price). Pure.
 */
export function poBillLines(rows: PoCopyLine[]): { lines: OwnBillLine[]; priced: boolean } {
  let priced = true;
  const lines: OwnBillLine[] = [];
  const ordered = [...rows].sort((a, b) => Number(a.line_id ?? 0) - Number(b.line_id ?? 0));
  for (const r of ordered) {
    const quantity = num(r.quantity) ?? 0;
    const open = fourPlaces(quantity - (num(r.quantity_billed) ?? 0));
    if (!(open > 0)) continue;
    const amount = num(r.amount);
    const rate = num(r.rate) ?? (amount !== null && quantity > 0 ? amount / quantity : null);
    if (rate === null) priced = false;
    lines.push({
      lineNo: lines.length + 1,
      accountId: null,
      itemId: numericId(r.item_netsuite_id),
      itemNumber: text(r.item_number),
      description: text(r.description),
      quantity: open,
      rate,
      cents: rate === null ? null : toCents(open * rate),
      poLineId: text(r.line_id),
    });
  }
  return { lines, priced };
}

/** The copy as gl_own_bill_save takes it. */
export function billPayload(own: OwnBill): Record<string, unknown> {
  return {
    netsuite_id: own.netsuiteId,
    netsuite_number: own.netsuiteNumber,
    subsidiary_id: own.subsidiaryId,
    made_from: own.madeFrom,
    made_from_id: own.madeFromId,
    vendor_netsuite_id: own.vendorId,
    vendor_name: own.vendorName,
    reference_no: own.referenceNo,
    bill_date: own.billDate,
    po_netsuite_id: own.poId,
    po_number: own.poNumber,
    location_netsuite_id: own.locationId,
    invoice_total: own.invoiceCents === null ? null : (own.invoiceCents / 100).toFixed(2),
    unknowns: own.unknowns,
    made_by: own.madeBy,
    lines: own.lines.map((l) => ({
      line_no: l.lineNo,
      account_netsuite_id: l.accountId,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      amount: l.cents === null ? null : (l.cents / 100).toFixed(2),
      po_line_id: l.poLineId,
    })),
  };
}

// ── Saving ─────────────────────────────────────────────────────────────────

/** What one of the three bill buttons knows once NetSuite has made the bill. */
export interface MadeBill {
  netsuiteId: string | null | undefined;
  netsuiteNumber?: string | null;
  madeFrom: BillMadeFrom;
  madeFromId?: string | null;
  madeBy?: string | null;
  vendorId?: string | number | null;
  vendorName?: string | null;
  referenceNo?: string | null;
  subsidiaryId?: string | number | null;
  locationId?: string | number | null;
  /** A vendor invoice's or payout's one expense line, as sent. */
  expense?: { accountId: string | number; amount: number; memo?: string | null } | null;
  /** The purchase order a Parts Mail bill was made from: its row in FleetSuite's copy, NetSuite's id and number. */
  po?: { copyId: string | null; netsuiteId: string | number | null; number: string | null } | null;
  /** What the vendor's invoice said it came to, in dollars. */
  invoiceTotal?: number | string | null;
}

/** Books' own copy of a bill from what the button knows and, for a PO's bill, FleetSuite's copy of the PO's lines. Pure. */
export function workOutOwnBill(made: MadeBill & { netsuiteId: string }, poLines: PoCopyLine[] | null, at: Date): OwnBill {
  const unknowns: BillUnknown[] = [];
  let lines: OwnBillLine[] = [];
  if (made.expense) {
    lines = [{
      lineNo: 1,
      accountId: numericId(made.expense.accountId),
      itemId: null,
      itemNumber: null,
      description: text(made.expense.memo),
      quantity: null,
      rate: null,
      cents: toCents(made.expense.amount),
      poLineId: null,
    }];
  } else if (poLines === null) {
    unknowns.push('lines');
  } else {
    const fromPo = poBillLines(poLines);
    lines = fromPo.lines;
    if (!fromPo.priced) unknowns.push('prices');
  }
  const invoice = num(made.invoiceTotal);
  return {
    netsuiteId: made.netsuiteId,
    netsuiteNumber: text(made.netsuiteNumber),
    subsidiaryId: numericId(made.subsidiaryId),
    madeFrom: made.madeFrom,
    madeFromId: text(made.madeFromId),
    vendorId: numericId(made.vendorId),
    vendorName: text(made.vendorName),
    referenceNo: text(made.referenceNo),
    billDate: chicagoDate(at),
    poId: numericId(made.po?.netsuiteId),
    poNumber: text(made.po?.number),
    locationId: numericId(made.locationId),
    invoiceCents: invoice === null ? null : toCents(invoice),
    lines,
    unknowns,
    madeBy: made.madeBy ?? null,
  };
}

/** What FleetSuite's copy of a purchase order has for its lines; null when the copy doesn't have the order. */
export async function readPoCopyLines(service: SupabaseClient, copyId: string | null): Promise<PoCopyLine[] | null> {
  if (!copyId) return null;
  const res = await service
    .from('netsuite_vendor_po_lines')
    .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_billed, rate, amount')
    .eq('po_id', copyId);
  if (res.error) throw new Error(res.error.message);
  const rows = (res.data ?? []) as PoCopyLine[];
  return rows.length ? rows : null;
}

/**
 * Saves Books' own copy of a bill FleetSuite just made. Never throws: the bill exists in NetSuite whatever happens
 * here, so a copy that can't be made is logged and the bill goes on.
 */
export async function saveOwnBill(service: SupabaseClient, made: MadeBill, at: Date = new Date()): Promise<SaveResult> {
  const netsuiteId = numericId(made.netsuiteId);
  if (!netsuiteId) return { saved: false, reason: "NetSuite didn't say which bill it made" };
  try {
    const poLines = made.expense ? null : await readPoCopyLines(service, made.po?.copyId ?? null);
    const own = workOutOwnBill({ ...made, netsuiteId }, poLines, at);
    const { data, error } = await service.rpc('gl_own_bill_save', { p: billPayload(own) });
    if (error) throw new Error(error.message);
    const saved = !!(data as { saved?: boolean } | null)?.saved;
    return saved ? { saved } : { saved, reason: 'already saved' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of NetSuite bill ${netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
