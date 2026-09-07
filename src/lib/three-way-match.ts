import type { SupabaseClient } from '@supabase/supabase-js';
import { isOpenPoStatus, normalizeItemNumber } from './vendor-po-sync';

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
 * override).
 */

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
  /** false = the PO is terminal in NetSuite (fully billed / closed / cancelled). */
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
}

const money = (n: number) =>
  `$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function computeThreeWayMatch(i: ThreeWayInputs): ThreeWayMatch {
  const tolerancePct = i.tolerancePct ?? 2;
  const toleranceAbs = i.toleranceAbs ?? 25;
  const reds: string[] = [];
  const ambers: string[] = [];

  // Leg 3: prior billing — a second bill against the same PO is the
  // double-pay case, always red.
  if (i.priorBills.length > 0) {
    reds.push(`This PO already has ${i.priorBills.length === 1 ? 'a bill' : `${i.priorBills.length} bills`} posted (${i.priorBills.join(', ')}) — billing it again pays twice unless this is deliberately a second tranche.`);
  }
  if (i.poIsOpen === false) {
    reds.push(`The PO is ${i.poStatusLabel || 'closed'} in NetSuite — it should not take a new bill unless this is a deliberate correction.`);
  }

  // Leg 1: invoice total vs PO total.
  let totalDiff: number | null = null;
  if (i.invoiceTotal == null) {
    ambers.push('The invoice total could not be read from the document — compare the amount by hand before billing.');
  } else if (i.poTotal == null) {
    ambers.push('The PO has no total on the mirror — compare the amount by hand before billing.');
  } else {
    totalDiff = Math.round((i.invoiceTotal - i.poTotal) * 100) / 100;
    const allowed = Math.max(toleranceAbs, (Math.abs(i.poTotal) * tolerancePct) / 100);
    if (Math.abs(totalDiff) > allowed) {
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
    if (totalReceived === 0) reds.push(`Nothing on this PO has been received. ${line}`);
    else ambers.push(line);
  }

  const variances = [...reds, ...ambers];
  return {
    verdict: reds.length > 0 ? 'red' : ambers.length > 0 ? 'amber' : 'green',
    variances,
    totalDiff,
    shortReceived,
    priorBills: i.priorBills,
  };
}

// ── Loader ────────────────────────────────────────────────────────────────

/**
 * Build the three legs for one captured invoice against its matched vendor
 * PO and run the match. Received per line = the mirror's quantity_received
 * (NetSuite truth, also bumped immediately by posted dock receipts) plus
 * any 'manual_needed' po_receipts rows — dock arrivals whose NetSuite
 * receipt hasn't been keyed yet, the one case the mirror can't see.
 * Prior bills = sibling captured invoices already billed against this PO,
 * plus NetSuite's own quantity_billed on the lines.
 */
export async function loadThreeWayMatchForPo(
  service: SupabaseClient,
  matchedPoId: string,
  invoiceTotal: number | null,
  excludeInvoiceId?: string,
): Promise<{ match: ThreeWayMatch; poTranid: string | null }> {
  const { data: po, error: poErr } = await service
    .from('netsuite_vendor_pos')
    .select('id, tranid, status, status_label, total')
    .eq('id', matchedPoId)
    .maybeSingle();
  if (poErr || !po) throw new Error('three-way match: PO not found' + (poErr ? ` (${poErr.message})` : ''));

  const [{ data: lines, error: lErr }, { data: receipts, error: rErr }, { data: siblings, error: sErr }] = await Promise.all([
    service.from('netsuite_vendor_po_lines')
      .select('line_id, item_number, quantity, quantity_received, quantity_billed, amount')
      .eq('po_id', matchedPoId).order('id').limit(1000),
    service.from('po_receipts')
      .select('line_id, item_number, quantity, ns_status')
      .eq('po_id', matchedPoId).order('id').limit(1000),
    service.from('vendor_parts_invoices')
      .select('id, invoice_number, netsuite_bill_number, netsuite_bill_id')
      .eq('matched_po_id', matchedPoId).eq('status', 'billed').limit(20),
  ]);
  if (lErr) throw new Error('three-way match lines: ' + lErr.message);
  if (rErr) throw new Error('three-way match receipts: ' + rErr.message);
  if (sErr) throw new Error('three-way match prior bills: ' + sErr.message);

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
  for (const l of lines || []) {
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

  const priorBills: string[] = (siblings || [])
    .filter(s => s.id !== excludeInvoiceId)
    .map(s => String(s.netsuite_bill_number || s.netsuite_bill_id || s.invoice_number || 'bill'));
  if (billedUnits > 0) {
    priorBills.push(`NetSuite shows ${billedUnits} unit${billedUnits !== 1 ? 's' : ''} already billed on this PO`);
  }

  const poTotal = po.total != null ? Number(po.total) : (sawAmount ? Math.round(lineAmountSum * 100) / 100 : null);
  const match = computeThreeWayMatch({
    invoiceTotal: invoiceTotal != null ? Number(invoiceTotal) : null,
    poTotal,
    lines: matchLines,
    priorBills,
    poIsOpen: isOpenPoStatus(po.status),
    poStatusLabel: po.status_label || po.status || null,
  });
  return { match, poTranid: po.tranid || null };
}
