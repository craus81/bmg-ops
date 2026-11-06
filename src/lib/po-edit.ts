/**
 * Edit a vendor PO from Purchasing → Vendor POs (Craig, 2026-11-06).
 *
 * What can change, as Craig picked:
 * - each line's quantity and price, take a line off, add parts;
 * - move lines to another vendor (they go on a new PO with that vendor and
 *   come off this one);
 * - the memo, the expected date and the ship-to address.
 *
 * Rules:
 * - any PO that isn't fully received or closed can be edited;
 * - a line with anything billed, or a closed line, can't change at all;
 * - a line with parts received can't go below what came in, and can't be
 *   removed or moved;
 * - a PO always keeps at least one open part (closing a whole PO stays in
 *   NetSuite);
 * - when a quantity a job needs drops, the parts no longer on order go
 *   back to the parts queue (po-edit-server.ts), the same as Undo.
 *
 * Everything is planned against the PO read live from NetSuite, never the
 * mirror, and the save is refused when NetSuite's copy changed after the
 * window opened.
 *
 * Client-safe: the window uses the same rules to lock lines and explain.
 */

import type { PoItemLine } from '@/lib/netsuite';
import { EMPTY_SHIP_TO, sameShipTo, shipToFromRecord, shippingAddressBody, type ShipTo } from '@/lib/drop-ship';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** NetSuite PO status letters that can't be edited: received (Pending
 *  Bill / Fully Billed) and closed (Rejected / Closed). */
const NOT_EDITABLE = new Set(['F', 'G', 'C', 'H']);

export function canEditPo(status: string | null | undefined): boolean {
  return !status || !NOT_EDITABLE.has(String(status).toUpperCase());
}

/** The shop, for "Ship to the shop". */
export const SHOP_SHIP_TO: ShipTo = {
  ...EMPTY_SHIP_TO,
  name: 'BMG Fleet Installations',
  address: '1082 Cool Springs Industrial Dr.',
  city: "O'Fallon",
  state: 'MO',
  zip: '63366',
};

export interface PoEditHeader {
  memo: string;
  /** YYYY-MM-DD: NetSuite's Receive By date, which FleetSuite shows as the expected date. */
  dueDate: string | null;
  shipTo: ShipTo;
}

/** The header of a live PO record (GET …?expandSubResources=true); its
 *  lines come from netsuite.ts poItemLinesFromRecord. */
export function parsePoHeader(rec: any): { header: PoEditHeader; lastModified: string | null } {
  return {
    header: {
      memo: String(rec?.memo ?? ''),
      dueDate: day(rec?.dueDate),
      shipTo: shipToFromRecord(rec),
    },
    lastModified: rec?.lastModifiedDate ? String(rec.lastModifiedDate) : null,
  };
}

const day = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
};

/** Why a line can't change at all, or null when it can. */
export function lineLock(l: Pick<PoItemLine, 'isClosed' | 'quantityBilled'>): 'billed' | 'closed' | null {
  if (l.quantityBilled > 0) return 'billed';
  if (l.isClosed) return 'closed';
  return null;
}

/** The lowest quantity a line can go to: what was received, and never 0 (that's Remove). */
export function lineFloor(l: Pick<PoItemLine, 'quantityReceived'>): number {
  return Math.max(l.quantityReceived, 0) || 0;
}

/** Received parts can't be taken off or moved. */
export function canTakeOff(l: Pick<PoItemLine, 'quantityReceived' | 'quantityBilled' | 'isClosed'>): boolean {
  return !lineLock(l) && l.quantityReceived <= 0;
}

export interface PoLineEdit {
  line: number;
  quantity?: number;
  /** Left out or null: the price stays as it is. */
  rate?: number | null;
  remove?: boolean;
  /** Goes to the new PO with the other vendor. */
  move?: boolean;
}

export interface PoNewLine {
  itemId: string;
  itemNumber: string;
  quantity: number;
  rate: number | null;
  description: string | null;
}

export interface PoLineChange {
  line: number;
  itemId: string;
  from: number;
  to: number;
}

export type PoEditPlan =
  | { ok: false; error: string }
  | {
      ok: true;
      /** The item sublist PATCH (empty when only the header changes). */
      items: Record<string, unknown>[];
      /** Set when a line comes off: the item sublist becomes exactly `items`. */
      replace: boolean;
      removed: PoItemLine[];
      moved: PoItemLine[];
      /** Lines whose quantity changed (removed and moved lines are not here). */
      qtyChanges: PoLineChange[];
      added: PoNewLine[];
      /** Plain-words list for the alert and the vendor email. */
      changes: string[];
    };

const money = (n: number | null) => (n == null ? 'no price' : `$${n.toFixed(2)}`);

/**
 * What to send NetSuite for the window's line edits. `labels` names each
 * NetSuite item id by its part number for the words.
 */
export function planPoEdit(
  live: PoItemLine[],
  edits: PoLineEdit[],
  adds: PoNewLine[],
  labels: Map<string, string>,
): PoEditPlan {
  const byLine = new Map(live.map(l => [l.line, l]));
  const name = (l: PoItemLine) => labels.get(l.itemId) || `item ${l.itemId}`;
  const changes: string[] = [];
  const removed: PoItemLine[] = [];
  const moved: PoItemLine[] = [];
  const qtyChanges: PoLineChange[] = [];
  const patched = new Map<number, Record<string, unknown>>();

  for (const e of edits) {
    const l = byLine.get(e.line);
    if (!l) return { ok: false, error: 'A line on this PO changed in NetSuite while you were editing. Close the window and open it again.' };
    const qtyChanged = e.quantity !== undefined && round2(e.quantity) !== round2(l.quantity);
    // A blank price leaves NetSuite's as is.
    const rateChanged = e.rate != null && (l.rate == null || round2(e.rate) !== round2(l.rate));
    const touched = !!e.remove || !!e.move || qtyChanged || rateChanged;
    if (!touched) continue;
    const lock = lineLock(l);
    if (lock) {
      return { ok: false, error: `${name(l)} is ${lock === 'billed' ? 'billed' : 'closed'} in NetSuite, so it can't change.` };
    }
    if (e.remove && e.move) return { ok: false, error: `${name(l)} can be removed or moved, not both.` };
    if (e.remove || e.move) {
      if (!canTakeOff(l)) {
        return { ok: false, error: `${name(l)} has parts received, so it can't be ${e.remove ? 'removed' : 'moved'}. Lower it to what came in instead.` };
      }
      if (e.remove) { removed.push(l); changes.push(`Removed ${name(l)} (${l.quantity})`); }
      else { moved.push(l); changes.push(`Moved ${name(l)} (${l.quantity}) to a new PO`); }
      continue;
    }
    const body: Record<string, unknown> = { line: l.line };
    if (qtyChanged) {
      const q = round2(e.quantity!);
      if (!(q > 0)) return { ok: false, error: `${name(l)} needs a quantity above 0. To take it off, use Remove.` };
      if (q < lineFloor(l)) {
        return { ok: false, error: `${name(l)} can't go below ${l.quantityReceived}: that many were already received.` };
      }
      body.quantity = q;
      qtyChanges.push({ line: l.line, itemId: l.itemId, from: l.quantity, to: q });
      changes.push(`${name(l)} quantity ${l.quantity} → ${q}`);
    }
    if (rateChanged) {
      if (!(e.rate! >= 0)) return { ok: false, error: `${name(l)} needs a price of 0 or more.` };
      body.rate = round2(e.rate!);
      changes.push(`${name(l)} price ${money(l.rate)} → ${money(round2(e.rate!))}`);
    }
    patched.set(l.line, body);
  }

  for (const a of adds) {
    if (!a.itemId) return { ok: false, error: `${a.itemNumber || 'A new part'} isn't in NetSuite yet, so it can't go on a PO.` };
    if (!(a.quantity > 0)) return { ok: false, error: `${a.itemNumber} needs a quantity above 0.` };
    changes.push(`Added ${a.itemNumber} (${round2(a.quantity)}${a.rate != null && a.rate > 0 ? ` at ${money(round2(a.rate))}` : ''})`);
  }

  const off = new Set([...removed, ...moved].map(l => l.line));
  const stillOpen = live.filter(l => !off.has(l.line) && !l.isClosed).length + adds.length;
  if (stillOpen === 0) {
    return { ok: false, error: 'A PO needs at least one part. To cancel the whole PO, close it in NetSuite.' };
  }

  const newLines = adds.map(a => ({
    item: { id: a.itemId },
    quantity: round2(a.quantity),
    ...(a.rate != null && a.rate > 0 ? { rate: round2(a.rate) } : {}),
    ...(a.description ? { description: a.description } : {}),
  }));
  const replace = off.size > 0;
  const items = replace
    // Every kept line by its key (with its changes), the others left out.
    ? [...live.filter(l => !off.has(l.line)).map(l => patched.get(l.line) || { line: l.line }), ...newLines]
    : [...patched.values(), ...newLines];

  return { ok: true, items, replace, removed, moved, qtyChanges, added: adds, changes };
}

/** The header part of the PATCH body, and its words. */
export function planPoHeader(before: PoEditHeader, after: Partial<PoEditHeader>): { body: Record<string, unknown>; changes: string[] } {
  const body: Record<string, unknown> = {};
  const changes: string[] = [];
  if (after.memo !== undefined && after.memo.trim() !== before.memo.trim()) {
    body.memo = after.memo.trim().slice(0, 999);
    changes.push('Memo changed');
  }
  if (after.dueDate !== undefined && (after.dueDate || null) !== (before.dueDate || null)) {
    body.dueDate = after.dueDate || null;
    changes.push(after.dueDate ? `Expected date ${shortDay(after.dueDate)}` : 'Expected date cleared');
  }
  if (after.shipTo !== undefined && !sameShipTo(before.shipTo, after.shipTo)) {
    body.shippingAddress = shippingAddressBody(after.shipTo);
    changes.push(`Ship to ${[after.shipTo.name, after.shipTo.city].filter(Boolean).join(', ') || 'changed'}`);
  }
  return { body, changes };
}

function shortDay(d: string): string {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface HeldRequest { id: string; quantity: number }

/**
 * Which requests on a line stay on order when the line drops to `keep`, and
 * how much of each goes back to the queue. Requests are kept oldest first
 * (the order given); the last one kept may be split.
 */
export function splitRequestsForQty(requests: HeldRequest[], keep: number): {
  stay: HeldRequest[];
  /** Part of a request goes back: it stays on order with `quantity`, the rest is queued. */
  split: { id: string; quantity: number; back: number } | null;
  back: HeldRequest[];
} {
  let left = round2(Math.max(keep, 0));
  const stay: HeldRequest[] = [];
  const back: HeldRequest[] = [];
  let split: { id: string; quantity: number; back: number } | null = null;
  for (const r of requests) {
    const q = round2(Number(r.quantity) || 0);
    if (left >= q) { stay.push(r); left = round2(left - q); continue; }
    if (left > 0) { split = { id: r.id, quantity: left, back: round2(q - left) }; left = 0; continue; }
    back.push(r);
  }
  return { stay, split, back };
}
