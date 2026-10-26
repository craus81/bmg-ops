import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeItemNumber } from './vendor-po-sync';

/**
 * Three-way match on vendor bills (R4-8). The one-click "Create Bill" on
 * Parts Mail posts a real NetSuite vendor bill by copying the PO — before
 * this, the AI-extracted invoice total was never compared to anything, so
 * an over-invoice, freight add, short-ship, or second bill just got paid.
 * This is the comparison: invoice (what the vendor asks) vs PO (what was
 * ordered) vs dock receipts (what actually arrived), plus prior bills
 * against the same PO.
 *
 * Pure math — the route builds the inputs and enforces the verdict
 * (green bills one-click; anything else needs a typed, audit-logged
 * override). Snap a bill runs the same match before it bills a PO a snapped
 * bill names (migration 444, src/lib/books/snap-po.ts), and a PO billed
 * there counts as an earlier bill here.
 */

/**
 * NetSuite PO statuses that can't take a bill: A Pending Supervisor Approval,
 * C Rejected by Supervisor, G Fully Billed, H Closed, P Planned. F, Pending
 * Bill, is the usual one to bill: everything received, the vendor's bill
 * still to come. (isOpenPoStatus in vendor-po-sync.ts is about receiving,
 * where F has nothing left to receive; the match used it until migration 444,
 * so a fully received PO read as closed.)
 */
const NO_BILL_PO_STATUSES = ['A', 'C', 'G', 'H', 'P'];

export function canBillPoStatus(status: string | null | undefined): boolean {
  return !NO_BILL_PO_STATUSES.includes(String(status || '').toUpperCase());
}

export interface ThreeWayLine {
  itemNumber: string;
  ordered: number;
  received: number;
}

export interface ThreeWayInputs {
  /** AI-extracted invoice total; null = extraction didn't capture one. */
  invoiceTotal: number | null;
  /** The mirrored PO's total. */
  poTotal: number | null;
  /** PO lines with dock-received quantities. Empty = no receipt data. */
  lines: ThreeWayLine[];
  /** Bill references already posted against this PO (other invoices / stamps). */
  priorBills: string[];
  /** false = the PO can't take a bill in NetSuite (fully billed, closed, rejected…): canBillPoStatus. */
  poIsOpen?: boolean;
  poStatusLabel?: string | null;
  /** Variance tolerance: the larger of pct-of-PO and abs dollars passes. */
  tolerancePct?: number;
  toleranceAbs?: number;
}

export type MatchVerdict = 'green' | 'amber' | 'red';

export interface ThreeWayMatch {
  verdict: MatchVerdict;
  /** Human sentences naming each variance, worst first. */
  variances: string[];
  totalDiff: number | null;
  shortReceived: ThreeWayLine[];
  priorBills: string[];
  /** Each leg's own verdict: invoice vs PO total, receipts vs ordered, earlier bills and the PO's status. */
  legs: { totals: MatchVerdict; received: MatchVerdict; earlier: MatchVerdict };
  /** The most the totals may differ by and still pass, in dollars; null when they weren't compared. */
  allowed: number | null;
}

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function computeThreeWayMatch(i: ThreeWayInputs): ThreeWayMatch {
  const tolerancePct = i.tolerancePct ?? 2;
  const toleranceAbs = i.toleranceAbs ?? 25;
  const reds: string[] = [];
  const ambers: string[] = [];
  const legs: ThreeWayMatch['legs'] = { totals: 'green', received: 'green', earlier: 'green' };

  // Leg 3: prior billing — a second bill against the same PO is the
  // double-pay case, always red.
  if (i.priorBills.length > 0) {
    legs.earlier = 'red';
    reds.push(`This PO already has ${i.priorBills.length === 1 ? 'a bill' : `${i.priorBills.length} bills`} posted (${i.priorBills.join(', ')}) — billing it again pays twice unless this is deliberately a second tranche.`);
  }
  if (i.poIsOpen === false) {
    legs.earlier = 'red';
    reds.push(`The PO is ${i.poStatusLabel || 'closed'} in NetSuite — it should not take a new bill unless this is a deliberate correction.`);
  }

  // Leg 1: invoice total vs PO total.
  let totalDiff: number | null = null;
  let allowed: number | null = null;
  if (i.invoiceTotal == null) {
    legs.totals = 'amber';
    ambers.push('The invoice total could not be read from the document — compare the amount by hand before billing.');
  } else if (i.poTotal == null) {
    legs.totals = 'amber';
    ambers.push('The PO has no total on the mirror — compare the amount by hand before billing.');
  } else {
    totalDiff = Math.round((i.invoiceTotal - i.poTotal) * 100) / 100;
    allowed = Math.round(Math.max(toleranceAbs, (Math.abs(i.poTotal) * tolerancePct) / 100) * 100) / 100;
    if (Math.abs(totalDiff) > allowed) {
      legs.totals = 'red';
      reds.push(`Invoice ${money(i.invoiceTotal)} vs PO ${money(i.poTotal)} — ${money(totalDiff)} ${totalDiff > 0 ? 'over' : 'under'}.`);
    }
  }

  // Leg 2: dock receipts vs ordered. Billing the full PO with units still
  // undelivered pays for parts not yet in the building.
  const shortReceived = i.lines.filter(l => l.received < l.ordered);
  if (i.lines.length > 0 && shortReceived.length > 0) {
    const totalOrdered = i.lines.reduce((s, l) => s + l.ordered, 0);
    const totalReceived = i.lines.reduce((s, l) => s + Math.min(l.received, l.ordered), 0);
    const detail = shortReceived.slice(0, 4).map(l => `${l.itemNumber} ${l.received} of ${l.ordered}`).join(', ');
    const line = `Received ${totalReceived} of ${totalOrdered} ordered units (${detail}${shortReceived.length > 4 ? ', …' : ''}).`;
    if (totalReceived === 0) {
      legs.received = 'red';
      reds.push(`Nothing on this PO has been received. ${line}`);
    } else {
      legs.received = 'amber';
      ambers.push(line);
    }
  }

  const variances = [...reds, ...ambers];
  return {
    verdict: reds.length > 0 ? 'red' : ambers.length > 0 ? 'amber' : 'green',
    variances,
    totalDiff,
    shortReceived,
    priorBills: i.priorBills,
    legs,
    allowed,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────

/** One line of a PO, as FleetSuite's copy of NetSuite's POs has it (netsuite_vendor_po_lines). */
export interface PoLineRow {
  line_id: string | null;
  item_netsuite_id: string | null;
  item_number: string | null;
  description: string | null;
  quantity: number | string | null;
  quantity_received: number | string | null;
  quantity_billed: number | string | null;
  rate: number | string | null;
  amount: number | string | null;
}

/** What the match reads for one PO, besides the invoice's own total. */
export interface PoMatchFacts {
  poTranid: string | null;
  /** The PO's total, else its lines' amounts added up; null when the copy has neither. */
  poTotal: number | null;
  poIsOpen: boolean;
  poStatusLabel: string | null;
  /** Each line with something ordered: ordered and received. */
  lines: ThreeWayLine[];
  /** What the match takes as bills already on the PO: earlierBills, then NetSuite's billed units as a sentence. */
  priorBills: string[];
  /** The bills FleetSuite knows are on the PO: Parts Mail's and snapped ones, by number. */
  earlierBills: string[];
  /** The units NetSuite shows billed on the PO's lines. */
  billedUnits: number;
  /** The PO's lines as copied, for what billing it bills (src/lib/books/own-bills.ts poBillLines). */
  rows: PoLineRow[];
}

/** A snapped bill's columns not in PostgREST's schema cache yet, right after migration 444 deploys (#741). */
const snappedNotCachedYet = (e: { code?: string; message?: string }) =>
  e.code === 'PGRST204' || e.code === '42703' || /billed_po_netsuite_id/i.test(e.message || '');

/**
 * The legs of the match for one PO. Received per line = the mirror's
 * quantity_received (NetSuite truth, also bumped immediately by posted dock
 * receipts) plus any 'manual_needed' po_receipts rows — dock arrivals whose
 * NetSuite receipt hasn't been keyed yet, the one case the mirror can't see.
 * Prior bills = sibling captured invoices already billed against this PO,
 * snapped bills that billed it (migration 444), plus NetSuite's own
 * quantity_billed on the lines. exclude leaves out the invoice or snapped
 * bill being billed.
 */
export async function loadPoMatchFacts(
  service: SupabaseClient,
  poId: string,
  exclude: { invoiceId?: string; snappedId?: string } = {},
): Promise<PoMatchFacts> {
  const { data: po, error: poErr } = await service
    .from('netsuite_vendor_pos')
    .select('id, netsuite_id, tranid, status, status_label, total')
    .eq('id', poId)
    .maybeSingle();
  if (poErr || !po) throw new Error('three-way match: PO not found' + (poErr ? ` (${poErr.message})` : ''));

  const [{ data: lines, error: lErr }, { data: receipts, error: rErr }, { data: siblings, error: sErr }, snapped] = await Promise.all([
    service.from('netsuite_vendor_po_lines')
      .select('line_id, item_netsuite_id, item_number, description, quantity, quantity_received, quantity_billed, rate, amount')
      .eq('po_id', poId).order('id').limit(1000),
    service.from('po_receipts')
      .select('line_id, item_number, quantity, ns_status')
      .eq('po_id', poId).order('id').limit(1000),
    service.from('vendor_parts_invoices')
      .select('id, invoice_number, netsuite_bill_number, netsuite_bill_id')
      .eq('matched_po_id', poId).eq('status', 'billed').limit(20),
    service.from('gl_snapped_bills')
      .select('id, netsuite_number, bill_number')
      .eq('billed_po_netsuite_id', String(po.netsuite_id)).eq('status', 'sent').limit(20),
  ]);
  if (lErr) throw new Error('three-way match lines: ' + lErr.message);
  if (rErr) throw new Error('three-way match receipts: ' + rErr.message);
  if (sErr) throw new Error('three-way match prior bills: ' + sErr.message);
  if (snapped.error && !snappedNotCachedYet(snapped.error)) throw new Error('three-way match snapped bills: ' + snapped.error.message);

  // Dock receipts NetSuite hasn't absorbed yet, by mirror line (line_id
  // first, normalized item number as the fallback for hand-entered rows).
  const pendingByLineId = new Map<string, number>();
  const pendingByItem = new Map<string, number>();
  for (const r of receipts || []) {
    if (r.ns_status !== 'manual_needed') continue;
    const qty = Number(r.quantity) || 0;
    if (r.line_id) pendingByLineId.set(r.line_id, (pendingByLineId.get(r.line_id) || 0) + qty);
    else {
      const key = normalizeItemNumber(r.item_number);
      pendingByItem.set(key, (pendingByItem.get(key) || 0) + qty);
    }
  }

  let billedUnits = 0;
  let lineAmountSum = 0;
  let sawAmount = false;
  const matchLines: ThreeWayLine[] = [];
  for (const l of (lines || []) as PoLineRow[]) {
    billedUnits += Number(l.quantity_billed) || 0;
    if (l.amount != null) { lineAmountSum += Number(l.amount) || 0; sawAmount = true; }
    const ordered = Number(l.quantity) || 0;
    if (ordered <= 0) continue;
    const key = normalizeItemNumber(l.item_number);
    const pendingForItem = pendingByItem.get(key) || 0;
    if (pendingForItem > 0) pendingByItem.delete(key); // consume once, not per duplicate line
    matchLines.push({
      itemNumber: key || l.item_number || '?',
      ordered,
      received: (Number(l.quantity_received) || 0) + (l.line_id ? pendingByLineId.get(l.line_id) || 0 : 0) + pendingForItem,
    });
  }

  const earlierBills: string[] = [
    ...(siblings || [])
      .filter(s => s.id !== exclude.invoiceId)
      .map(s => String(s.netsuite_bill_number || s.netsuite_bill_id || s.invoice_number || 'bill')),
    ...(snapped.error ? [] : snapped.data || [])
      .filter(s => s.id !== exclude.snappedId)
      .map(s => String(s.netsuite_number || s.bill_number || 'a snapped bill')),
  ];
  const priorBills = [...earlierBills];
  if (billedUnits > 0) {
    priorBills.push(`NetSuite shows ${billedUnits} unit${billedUnits !== 1 ? 's' : ''} already billed on this PO`);
  }

  return {
    poTranid: po.tranid || null,
    poTotal: po.total != null ? Number(po.total) : (sawAmount ? Math.round(lineAmountSum * 100) / 100 : null),
    poIsOpen: canBillPoStatus(po.status),
    poStatusLabel: po.status_label || po.status || null,
    lines: matchLines,
    priorBills,
    earlierBills,
    billedUnits,
    rows: (lines || []) as PoLineRow[],
  };
}

/** The match for one captured invoice against its matched vendor PO (Parts Mail). */
export async function loadThreeWayMatchForPo(
  service: SupabaseClient,
  matchedPoId: string,
  invoiceTotal: number | null,
  excludeInvoiceId?: string,
): Promise<{ match: ThreeWayMatch; poTranid: string | null }> {
  const f = await loadPoMatchFacts(service, matchedPoId, { invoiceId: excludeInvoiceId });
  const match = computeThreeWayMatch({
    invoiceTotal: invoiceTotal != null ? Number(invoiceTotal) : null,
    poTotal: f.poTotal,
    lines: f.lines,
    priorBills: f.priorBills,
    poIsOpen: f.poIsOpen,
    poStatusLabel: f.poStatusLabel,
  });
  return { match, poTranid: f.poTranid };
}
