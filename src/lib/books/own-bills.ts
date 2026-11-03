import type { SupabaseClient } from '@supabase/supabase-js';
import { chicagoDate, type FixedSaveResult, type SaveResult } from './own-invoices';

/**
 * Books' own copy of each bill FleetSuite puts into NetSuite (migration 435;
 * owner decision 2026-10-24, thread "Replacing NetSuite with FleetSuite",
 * "Shared bills"; docs/books.md "FleetSuite's own bills and receipts").
 *
 * FleetSuite makes a bill four ways: Create Bill in NetSuite on an approved
 * vendor invoice (AP) or an approved installer payout, Create bill on a
 * Parts Mail invoice, and Send to NetSuite on Snap a bill (migration 436),
 * which bills the purchase order a snapped bill names (migration 444).
 * Right after NetSuite makes it, Books keeps its own copy of what FleetSuite
 * sent, worked out from what FleetSuite knows rather than read back from
 * NetSuite:
 *
 *   - a vendor invoice's or payout's bill is one expense line: the amount
 *     FleetSuite sent, to the account it sent (Subcontractors);
 *   - a snapped bill's lines are the expense lines FleetSuite sent, each its
 *     amount to the account picked for it;
 *   - a Parts Mail bill is made from the invoice's purchase order, which
 *     NetSuite bills at the PO's prices, so its lines are what FleetSuite's
 *     copy of the PO (netsuite_vendor_po_lines, copied every two hours) still
 *     had to bill, each its open quantity at the PO's price, to the cent,
 *     then the PO's other lines (freight, say: its Expenses tab, migration 515)
 *     no bill had yet, each its amount to its account, as NetSuite copies them
 *     onto the bill. The vendor's invoice total is kept beside them. A snapped
 *     bill that bills a PO is the same, with the line for what the vendor's
 *     bill has beyond the PO after them, its amount to the account picked for
 *     it;
 *   - the date is the day FleetSuite made it, in Central time: FleetSuite
 *     sends no date, and NetSuite dates the bill that day. A snapped bill is
 *     the exception: FleetSuite sends the vendor's date for it.
 *
 * What FleetSuite can't work out is said so on the copy (unknowns) rather
 * than guessed: a PO its copy doesn't have or shows nothing left to bill on,
 * other lines it hasn't read or can't say the bills of, a line it has no
 * price for. The
 * check (src/lib/books/own-bill-check.ts) puts each copy next to NetSuite's
 * bill. Nothing is written to NetSuite.
 *
 * Saving never stops a bill: the bill exists in NetSuite before the copy is
 * made, so a copy that can't be saved is logged and left.
 */

export type BillMadeFrom = 'vendor_invoice' | 'payout' | 'parts_mail' | 'snapped';
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
  /** 'YYYY-MM-DD': the date FleetSuite sent for the bill, else the day it made it in Central time. */
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

/** What FleetSuite's copy of a purchase order has for one of its other lines (migration 515): freight, say. */
export interface PoExpenseLine {
  line_id: string | null;
  account_netsuite_id: string | null;
  account_name?: string | null;
  memo: string | null;
  amount: number | string | null;
  /** NetSuite closed the line, so no bill takes it; null when the copy couldn't read it. */
  closed: boolean | null;
  /** NetSuite's ids for the bills that have the line, empty when none does; null when the copy couldn't read them. */
  billed_by: string[] | null;
}

/**
 * The PO's other lines a bill NetSuite makes from it takes: each one no bill has yet and NetSuite hasn't closed, its
 * amount to its account, numbered on from `after`. Known only when the copy has read them (`rows` isn't null) and, for
 * each, says which bills have it, whether it's closed, and its account. A line the copy already shows on `bill`
 * itself (NetSuite's id for a bill just made; null before there is one) isn't known either: the copy has read the PO
 * since the bill, so its item lines can't say what the bill took. Pure.
 */
export function poBillExpenseLines(
  rows: PoExpenseLine[] | null,
  bill: string | null,
  after: number,
): { lines: OwnBillLine[]; known: boolean; priced: boolean } {
  if (!Array.isArray(rows)) return { lines: [], known: false, priced: true };
  let known = true;
  let priced = true;
  const lines: OwnBillLine[] = [];
  const ordered = [...rows].sort((a, b) => Number(a.line_id ?? 0) - Number(b.line_id ?? 0));
  for (const r of ordered) {
    if (!Array.isArray(r.billed_by) || (bill !== null && r.billed_by.map(String).includes(bill))) {
      known = false;
      continue;
    }
    // An earlier bill has it, or NetSuite closed it: this bill doesn't.
    if (r.billed_by.length || r.closed === true) continue;
    const account = numericId(r.account_netsuite_id);
    if (r.closed !== false || !account) {
      known = false;
      continue;
    }
    const amount = num(r.amount);
    if (amount === null) priced = false;
    lines.push({
      lineNo: after + lines.length + 1,
      accountId: account,
      itemId: null,
      itemNumber: null,
      description: text(r.memo),
      quantity: null,
      rate: null,
      cents: amount === null ? null : toCents(amount),
      poLineId: text(r.line_id),
    });
  }
  return { lines, known, priced };
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

/** What one of the bill buttons knows once NetSuite has made the bill. */
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
  /** A snapped bill's expense lines, as sent: after the PO's lines when it billed one. */
  expenses?: Array<{ accountId: string | number; amount: number; memo?: string | null }> | null;
  /** 'YYYY-MM-DD', the date FleetSuite sent NetSuite for the bill: a snapped bill's own date. */
  billDate?: string | null;
  /** The purchase order the bill was made from (Parts Mail, Snap a bill): its row in FleetSuite's copy, NetSuite's id and number. */
  po?: { copyId: string | null; netsuiteId: string | number | null; number: string | null } | null;
  /** What the vendor's invoice said it came to, in dollars. */
  invoiceTotal?: number | string | null;
}

/** Expense lines as sent, numbered on from the lines before them. */
const expenseLines = (expenses: NonNullable<MadeBill['expenses']>, after: number): OwnBillLine[] => expenses.map((e, i) => ({
  lineNo: after + i + 1,
  accountId: numericId(e.accountId),
  itemId: null,
  itemNumber: null,
  description: text(e.memo),
  quantity: null,
  rate: null,
  cents: toCents(e.amount),
  poLineId: null,
}));

/**
 * Books' own copy of a bill from what the button knows and, for a PO's bill, FleetSuite's copy of the PO's item lines
 * (`poLines`, null when it has none) and of its other lines (`poExpenses`, null when it hasn't read them). Pure.
 */
export function workOutOwnBill(
  made: MadeBill & { netsuiteId: string },
  poLines: PoCopyLine[] | null,
  at: Date,
  poExpenses: PoExpenseLine[] | null,
): OwnBill {
  const unknowns: BillUnknown[] = [];
  let lines: OwnBillLine[] = [];
  if (made.expenses?.length && !made.po) {
    lines = expenseLines(made.expenses, 0);
  } else if (made.expense) {
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
  } else {
    // A PO's bill: the PO's open item lines, its other lines no bill had yet, then what a snapped bill had beyond the PO.
    const items = poLines === null ? null : poBillLines(poLines);
    const others = poBillExpenseLines(poExpenses, made.netsuiteId, items?.lines.length ?? 0);
    lines = [...(items?.lines ?? []), ...others.lines];
    if (items?.priced === false || !others.priced) unknowns.push('prices');
    // Nothing left to bill on the copy: it doesn't have the PO, or caught up with this bill already, so it can't say
    // what was billed; nor can it when it doesn't know the PO's other lines.
    if (!lines.length || !others.known) unknowns.push('lines');
    lines = [...lines, ...expenseLines(made.expenses ?? [], lines.length)];
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
    billDate: made.billDate && /^\d{4}-\d{2}-\d{2}$/.test(made.billDate) ? made.billDate : chicagoDate(at),
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

const EXPENSE_COLUMNS = 'line_id, account_netsuite_id, account_name, memo, amount, closed, billed_by';

/**
 * What FleetSuite's copy of a purchase order has for its other lines (migration 515); null when the copy hasn't read
 * them yet, or they can't be read now. Never throws: not knowing them is said so on the copy, not a reason to lose it.
 */
export async function readPoCopyExpenses(service: SupabaseClient, copyId: string | null): Promise<PoExpenseLine[] | null> {
  if (!copyId) return null;
  try {
    const po = await service.from('netsuite_vendor_pos').select('expense_lines_read_at').eq('id', copyId).maybeSingle();
    if (po.error) throw new Error(po.error.message);
    if (!(po.data as { expense_lines_read_at?: string | null } | null)?.expense_lines_read_at) return null;
    const res = await service.from('netsuite_vendor_po_expense_lines').select(EXPENSE_COLUMNS).eq('po_id', copyId);
    if (res.error) throw new Error(res.error.message);
    return (res.data ?? []) as PoExpenseLine[];
  } catch (err) {
    console.warn(`[books] the other lines of FleetSuite's copy of a PO (${copyId}) couldn't be read: ${String((err as any)?.message || err).slice(0, 200)}`);
    return null;
  }
}

/**
 * Saves Books' own copy of a bill FleetSuite just made. Never throws: the bill exists in NetSuite whatever happens
 * here, so a copy that can't be made is logged and the bill goes on.
 */
export async function saveOwnBill(service: SupabaseClient, made: MadeBill, at: Date = new Date()): Promise<SaveResult> {
  const netsuiteId = numericId(made.netsuiteId);
  if (!netsuiteId) return { saved: false, reason: "NetSuite didn't say which bill it made" };
  try {
    // Only a PO's bill reads the copy of the PO: a vendor invoice's or payout's line, or a plain snapped bill's, are as sent.
    const poBill = !made.expense && !(made.expenses?.length && !made.po);
    const copyId = made.po?.copyId ?? null;
    const poLines = poBill ? await readPoCopyLines(service, copyId) : null;
    const poExpenses = poBill ? await readPoCopyExpenses(service, copyId) : null;
    const own = workOutOwnBill({ ...made, netsuiteId }, poLines, at, poExpenses);
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

// ── A fix's next version ───────────────────────────────────────────────────

/** A line of a bill as a fix leaves it (src/lib/bill-fix.ts ownCopyLines, the order's line named by its id). */
export interface FixedBillCopyLine {
  accountId: string | null;
  itemId: string | null;
  itemNumber: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  cents: number;
  /** NetSuite's id for the purchase order line it bills, when FleetSuite could read it. */
  poLineId: string | null;
}

export interface FixedBillCopy {
  /** The vendor's number for the bill. */
  number: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  lines: FixedBillCopyLine[];
}

/**
 * The next version of FleetSuite's own copy of a bill it fixed (migration 472), as gl_own_bill_fix takes it: the
 * bill's number, date and lines as fixed. FleetSuite now knows every line and what each comes to, so nothing stays
 * unknown. Pure.
 */
export function fixedOwnBillPayload(
  netsuiteId: string,
  version: number,
  fixed: FixedBillCopy,
  opts: { fixId: string; by: string | null },
): Record<string, unknown> {
  const totalCents = fixed.lines.reduce((sum, l) => sum + l.cents, 0);
  return {
    netsuite_id: netsuiteId,
    version,
    fix_id: opts.fixId,
    fixed_by: opts.by,
    number: fixed.number,
    bill_date: fixed.date,
    total: (totalCents / 100).toFixed(2),
    lines: fixed.lines.map((l, i) => ({
      line_no: i + 1,
      account_netsuite_id: l.accountId,
      item_netsuite_id: l.itemId,
      item_number: l.itemNumber,
      description: l.description,
      quantity: l.quantity,
      rate: l.rate,
      amount: (l.cents / 100).toFixed(2),
      po_line_id: l.poLineId,
    })),
  };
}

/**
 * Makes the next version of FleetSuite's own copy of a bill it just fixed in NetSuite, keeping the one before. Never
 * throws: the fix is in NetSuite whatever happens here, so a copy that can't follow is logged, and Own bills says it
 * differs until it's put right.
 */
export async function saveFixedOwnBill(
  service: SupabaseClient,
  p: { netsuiteId: string; fixed: FixedBillCopy; fixId: string; by: string | null },
): Promise<FixedSaveResult> {
  try {
    const { data, error } = await service.from('gl_own_bills').select('netsuite_id, version').eq('netsuite_id', p.netsuiteId).maybeSingle();
    if (error) throw new Error(error.message);
    const saved = data as { netsuite_id: string; version: number } | null;
    if (!saved) return { saved: false, none: true, reason: 'no copy' };
    const res = await service.rpc('gl_own_bill_fix', { p: fixedOwnBillPayload(p.netsuiteId, saved.version, p.fixed, { fixId: p.fixId, by: p.by }) });
    if (res.error) throw new Error(res.error.message);
    const out = res.data as { saved?: boolean; version?: number; reason?: string } | null;
    if (out?.saved) return { saved: true, version: out.version };
    return { saved: false, reason: out?.reason === 'changed' ? 'the copy changed while the fix was being made' : 'the copy is gone' };
  } catch (err) {
    const reason = String((err as any)?.message || err).slice(0, 300);
    console.error(`[books] own copy of fixed NetSuite bill ${p.netsuiteId} not saved: ${reason}`);
    return { saved: false, reason };
  }
}
