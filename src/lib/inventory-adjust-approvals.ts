import { adjustmentChange, type AdjustMode } from './inventory-adjust-shared';

/**
 * Approving adjustments (Books part 63, migration 494, docs/books.md
 * "Adjustments approved before they're posted"): once it's switched on in
 * Books → Switches, an adjustment made with Adjust (src/lib/inventory-adjust.ts)
 * waits for a super admin who didn't ask to approve it, and only then goes to
 * NetSuite as an Inventory Adjustment; a super admin can turn it down instead,
 * saying why, and whoever asked can withdraw it while it waits. Until it's on,
 * Adjust posts at once, as it always has. Pure rules, shared by the Adjust
 * pop-up, Adjustments to approve (/admin/inventory/approvals) and the routes
 * (/api/inventory/adjust and /api/inventory/adjust/approvals).
 *
 * The change is worked out when it's asked, against NetSuite's live count at
 * the location then, and posted as that change once it's approved, so a shelf
 * count stays what the count found even if stock moves before it's approved.
 * One adjustment waits per item and location at a time. Nobody is alerted
 * (Craig, 2026-10-30: no alerts for adjustments).
 */

export type AskStatus = 'waiting' | 'sending' | 'unsure' | 'made' | 'turned_down' | 'withdrawn';

/** Not decided yet: one of these at a time per item and location. */
export const OPEN_STATUSES: readonly AskStatus[] = ['waiting', 'sending', 'unsure'];

/** How long a press of Approve can say it's posting before a super admin can settle it; the route stops at 60 seconds. */
export const STALE_MS = 5 * 60 * 1000;

export const WHY_MAX = 300;
export const NOTE_MAX = 500;
export const NUMBER_MAX = 60;

export const STATUS_TEXT: Readonly<Record<AskStatus, string>> = {
  waiting: 'Waiting for approval',
  sending: 'Being posted to NetSuite',
  unsure: "Posted, but NetSuite didn't say whether it took it",
  made: 'Made in NetSuite',
  turned_down: 'Turned down',
  withdrawn: 'Withdrawn',
};

/** Why it can't be approved, turned down, withdrawn or settled now. */
export const NOT_NOW_TEXT: Readonly<Record<AskStatus, string>> = {
  waiting: "It's waiting for approval, so there's nothing to settle.",
  sending: "It's being posted to NetSuite already.",
  unsure: "It was posted, but NetSuite didn't say whether it took it. Check NetSuite, then say whether it's there.",
  made: "It's made in NetSuite already.",
  turned_down: 'It was turned down already.',
  withdrawn: 'It was withdrawn already.',
};

/** An adjustment asked for, as the pages show it. */
export interface AdjustmentAsk {
  id: string;
  netsuiteItemId: string;
  itemNumber: string;
  /** The part's name in FleetSuite's parts list, where the route found it. */
  displayName: string | null;
  locationId: string;
  mode: AdjustMode;
  enteredQty: number;
  onHandThen: number;
  change: number;
  reason: string;
  note: string | null;
  status: AskStatus;
  askedBy: string | null;
  askedByName: string | null;
  askedAt: string;
  sentByName: string | null;
  sentAt: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  why: string | null;
  netsuiteNumber: string | null;
  error: string | null;
  warning: string | null;
}

export const ASK_COLUMNS = 'id, part_id, netsuite_item_id, item_number, location_id, mode, entered_qty, on_hand_then, change, reason, '
  + 'note, status, asked_by, asked_by_name, asked_at, sent_by_name, sent_at, decided_by_name, decided_at, why, '
  + 'netsuite_adjustment_number, error, warning';

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A row of inventory_adjustment_asks, or one its functions answered with, as the pages show it. */
export function askFromRow(row: Record<string, unknown>, displayName: string | null = null): AdjustmentAsk {
  return {
    id: String(row.id),
    netsuiteItemId: String(row.netsuite_item_id),
    itemNumber: String(row.item_number),
    displayName,
    locationId: String(row.location_id),
    mode: row.mode === 'count' ? 'count' : 'delta',
    enteredQty: Number(row.entered_qty),
    onHandThen: Number(row.on_hand_then),
    change: Number(row.change),
    reason: String(row.reason),
    note: text(row.note),
    status: row.status as AskStatus,
    askedBy: text(row.asked_by),
    askedByName: text(row.asked_by_name),
    askedAt: String(row.asked_at),
    sentByName: text(row.sent_by_name),
    sentAt: text(row.sent_at),
    decidedByName: text(row.decided_by_name),
    decidedAt: text(row.decided_at),
    why: text(row.why),
    netsuiteNumber: text(row.netsuite_adjustment_number),
    error: text(row.error),
    warning: text(row.warning),
  };
}

/**
 * The change an entry asks for against NetSuite's count now, or why it can't be asked: Adjust's own rules, and a
 * change that's a whole number, since it's posted as that change once it's approved.
 */
export function workOutAsk(mode: AdjustMode, qty: number, onHand: number): { change: number; after: number } | { error: string } {
  const calc = adjustmentChange(mode, qty, onHand);
  if ('error' in calc) return calc;
  if (!Number.isInteger(calc.change)) {
    return { error: `NetSuite shows ${onHand} on hand, which isn't a whole number, so a shelf count can't be asked for. Add or remove a whole number instead.` };
  }
  return calc;
}

/** What /api/inventory/adjust sends inventory_adjustment_ask, which works the change out again itself. */
export function askPayload(a: {
  id: string;
  by: string;
  byName: string | null;
  partId: string | null;
  netsuiteItemId: string;
  itemNumber: string;
  locationId: string;
  mode: AdjustMode;
  qty: number;
  onHand: number;
  reason: string;
  note: string | null;
}) {
  return {
    id: a.id, by: a.by, by_name: a.byName, part_id: a.partId, netsuite_item_id: a.netsuiteItemId, item_number: a.itemNumber,
    location_id: a.locationId, mode: a.mode, entered_qty: a.qty, on_hand_then: a.onHand, reason: a.reason, note: a.note,
  };
}

const signed = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)}`;

/** One line for what it asks: "Take 2 away · 7 on hand then → 5", or "Shelf count 12 · 9 on hand then → 12 (+3)". */
export function describeAsk(a: Pick<AdjustmentAsk, 'mode' | 'enteredQty' | 'onHandThen' | 'change'>): string {
  const after = a.onHandThen + a.change;
  if (a.mode === 'count') return `Shelf count ${a.enteredQty} · ${a.onHandThen} on hand then → ${after} (${signed(a.change)})`;
  return `${a.change > 0 ? `Add ${a.change}` : `Take ${-a.change} away`} · ${a.onHandThen} on hand then → ${after}`;
}

/** Why another can't be asked for, or posted, while this one's open. */
export function openText(a: Pick<AdjustmentAsk, 'itemNumber' | 'status' | 'askedByName' | 'mode' | 'enteredQty' | 'onHandThen' | 'change'>): string {
  const where = a.status === 'waiting'
    ? 'waiting for approval'
    : a.status === 'sending' ? 'being posted to NetSuite' : "that NetSuite didn't say whether it took";
  return `${a.itemNumber} has an adjustment ${where}, asked by ${a.askedByName || 'someone'}: ${describeAsk(a)}. `
    + "It's approved, turned down or withdrawn on Adjustments to approve before another can be made.";
}

/** Whether a super admin can settle it: NetSuite didn't say, or a press has said it's posting for longer than one takes. */
export function needsSettling(a: Pick<AdjustmentAsk, 'status' | 'sentAt'>, now = Date.now()): boolean {
  if (a.status === 'unsure') return true;
  if (a.status !== 'sending' || !a.sentAt) return false;
  return now - Date.parse(a.sentAt) >= STALE_MS;
}

/**
 * Whether Inventory Adjust's error leaves FleetSuite not knowing if NetSuite posted it: it lost touch with NetSuite
 * (createInventoryAdjustment, src/lib/netsuite.ts), or NetSuite answered with something other than a refusal (the
 * NetSuite feed's rule: a 4xx is a refusal, anything else may have been done). Every other error is from before
 * anything was sent, or NetSuite's refusal.
 */
export function leavesUnsure(error: string): boolean {
  if (error.startsWith("Couldn't reach NetSuite")) return true;
  const status = error.match(/^NetSuite refused the adjustment \((\d{3})\)/)?.[1];
  return status !== undefined && !(Number(status) >= 400 && Number(status) < 500);
}

/** It, ending with a full stop unless it ends a sentence already. */
export const sentence = (s: string): string => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** Who the NetSuite memo and Adjust's history say made it. */
export const approvedByName = (asker: string | null, approver: string | null): string =>
  `${asker || 'Someone'}, approved by ${approver || 'a super admin'}`;
