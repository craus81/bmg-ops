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
