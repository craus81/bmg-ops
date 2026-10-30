/**
 * Add parts to a vendor PO that is already open, instead of placing a
 * second PO with the same vendor (Craig, 2026-10-30: a PO goes out from the
 * Purchasing queue, then more parts for that vendor turn up a day later).
 *
 * Rules Craig set:
 * - only an open PO dated today or yesterday (less than 2 days old, shop
 *   time) can take more parts; anything older gets its own PO;
 * - a part already on the PO raises that line's quantity rather than
 *   adding a second line, as long as none of it has been received.
 *
 * Client-safe: the review screen and the queue page use the same window
 * the create-po route checks.
 */

import type { PoItemLine } from '@/lib/netsuite';

/** NetSuite PO status letters that can't take more parts: received
 *  (Pending Bill / Fully Billed) and closed (Rejected / Closed). */
const NOT_OPEN = new Set(['F', 'G', 'C', 'H']);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** YYYY-MM-DD in shop time (the shop runs on America/Chicago). */
export function shopDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(at);
}

/** The oldest PO date that can still take more parts: yesterday. */
export function oldestAddableDate(now: Date = new Date()): string {
  const [y, m, d] = shopDate(now).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

export function canAddToPo(po: { status?: string | null; trandate?: string | null }, now: Date = new Date()): boolean {
  if (po.status && NOT_OPEN.has(po.status)) return false;
  if (!po.trandate) return false;
  return po.trandate.slice(0, 10) >= oldestAddableDate(now);
}

export interface PoAdd {
  itemId: string;
  quantity: number;
  rate: number | null;
  description: string | null;
}

export interface PoAddPlan {
  /** The item sublist PATCH body (no `replace`): a line with its `line` key
   *  is updated in place, a line without one is added. */
  lines: Record<string, unknown>[];
  /** itemId → the quantity that line goes from and to, for raised lines. */
  raised: Map<string, { from: number; to: number }>;
  added: string[];
}

/** What to send NetSuite to put `adds` on a PO that already has `live` lines. */
export function planPoLineAdds(live: PoItemLine[], adds: PoAdd[]): PoAddPlan {
  const lines: Record<string, unknown>[] = [];
  const raised = new Map<string, { from: number; to: number }>();
  const added: string[] = [];
  for (const a of adds) {
    // The part's line, if it's still untouched: open, nothing received or billed.
    const mine = live.find(l => l.itemId === a.itemId && !l.isClosed && l.quantityReceived <= 0 && l.quantityBilled <= 0);
    if (mine) {
      const to = round2(mine.quantity + a.quantity);
      lines.push({ line: mine.line, quantity: to });
      raised.set(a.itemId, { from: mine.quantity, to });
    } else {
      lines.push({
        item: { id: a.itemId },
        quantity: a.quantity,
        ...(a.rate && a.rate > 0 ? { rate: a.rate } : {}),
        ...(a.description ? { description: a.description } : {}),
      });
      added.push(a.itemId);
    }
  }
  return { lines, raised, added };
}

/** The PO memo with any sales orders it doesn't name yet added on the end. */
export function memoWithSos(memo: string | null | undefined, soNumbers: string[]): string | null {
  const base = (memo || '').trim();
  const missing = [...new Set(soNumbers.filter(Boolean))].filter(so => !new RegExp(`\\b${so.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(base));
  if (missing.length === 0) return null;
  const next = base ? `${base} · SO ${missing.join(', ')}` : `FleetSuite purchase requests — for SO ${missing.join(', ')}`;
  return next.slice(0, 999);
}
