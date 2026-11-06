/**
 * "Parts ordered" on a sales order (Craig, 2026-11-06, thread "Mark sales
 * orders parts ordered"): the order turns green on the Sales orders list
 * once every part line is covered, meaning it is on a vendor PO (or drop
 * ship) for this order, or there is enough stock for it.
 *
 *   In stock = on hand and not held for another order. Stock is handed out
 *   the way the shop would: holds first (Reserve parts, quote holds), then
 *   the oldest open order first. So two orders can never count the same
 *   part on the shelf.
 *
 * Labor, freight and other 06 service lines, the FS-CUSTOM placeholder and
 * items that aren't physical parts don't count. An admin can also mark an
 * order by hand (migration 521); the mark stops counting once a part that
 * wasn't on the order when it was marked shows up.
 *
 * Client-safe and pure: the server half (so-parts-cover-server.ts) loads
 * the rows, this decides what they mean, so tests pin it.
 */

export type PartCoverState = 'po' | 'stock' | 'mixed' | 'missing';

export interface PartCover {
  item_number: string;
  description: string | null;
  needed: number;
  /** On a vendor PO / drop ship for this order. */
  onPo: number;
  /** Stock this order gets after holds and older orders. */
  fromStock: number;
  state: PartCoverState;
}

export interface SoPartsCover {
  /** Physical part lines (one per part number). */
  total: number;
  /** Parts fully covered. */
  ready: number;
  /** Every part covered, or a valid hand mark. */
  allReady: boolean;
  /** An admin marked it by hand and the mark still counts. */
  marked: { at: string; byName: string | null } | null;
  parts: PartCover[];
}

/** Part lines that never need ordering. */
export function isCountedItem(itemNumber: string, itemType: string | null | undefined): boolean {
  const k = String(itemNumber || '').trim().toUpperCase();
  if (!k || k === 'FS-CUSTOM') return false;
  if (k.startsWith('06')) return false;
  return ['INVTPART', 'NONINVTPART', 'ASSEMBLY', 'KIT'].includes(String(itemType || '').trim().toUpperCase());
}

export interface CoverOrder {
  key: string;
  /** Sort key for "oldest first": trandate, then NetSuite id. */
  date: string | null;
  netsuiteId: string;
  /** item → still needed (quantity minus billed). */
  needed: Map<string, number>;
  /** item → on a PO / drop ship for this order. */
  onPo: Map<string, number>;
  /** item → reserved for this order's job (part_allocations). */
  held: Map<string, number>;
}

/**
 * Hand out stock. `pool` is item → on hand minus holds that belong to no
 * order (quote holds). Returns order key → item → stock it gets.
 * Pass 1: each order takes what's reserved for it. Pass 2: oldest first.
 */
export function shareStock(orders: CoverOrder[], pool: Map<string, number>): Map<string, Map<string, number>> {
  const left = new Map(pool);
  const out = new Map<string, Map<string, number>>();
  const give = (o: CoverOrder, item: string, want: number) => {
    const have = Math.max(0, left.get(item) || 0);
    const take = Math.min(have, Math.max(0, want));
    if (take <= 0) return;
    left.set(item, have - take);
    const m = out.get(o.key) || new Map<string, number>();
    m.set(item, (m.get(item) || 0) + take);
    out.set(o.key, m);
  };
  const stockNeed = (o: CoverOrder, item: string) =>
    Math.max(0, (o.needed.get(item) || 0) - (o.onPo.get(item) || 0) - (out.get(o.key)?.get(item) || 0));

  for (const o of orders) {
    for (const [item, qty] of o.held) give(o, item, Math.min(qty, stockNeed(o, item)));
  }
  const sorted = [...orders].sort((a, b) => {
    const da = a.date || '9999';
    const db = b.date || '9999';
    if (da !== db) return da < db ? -1 : 1;
    return Number(a.netsuiteId) - Number(b.netsuiteId) || a.netsuiteId.localeCompare(b.netsuiteId);
  });
  for (const o of sorted) {
    for (const item of o.needed.keys()) give(o, item, stockNeed(o, item));
  }
  return out;
}

export function deriveSoPartsCover(input: {
  needed: Map<string, number>;
  descriptions?: Map<string, string | null>;
  onPo: Map<string, number>;
  fromStock: Map<string, number>;
  /** Items judged by their requests only (Misc / generic parts): no stock. */
  noStock?: Set<string>;
  mark?: { at: string | null; byName: string | null; items: string[] | null } | null;
}): SoPartsCover | null {
  const parts: PartCover[] = [];
  for (const [item, needed] of input.needed) {
    if (needed <= 0) continue;
    const onPo = Math.min(needed, input.onPo.get(item) || 0);
    const fromStock = input.noStock?.has(item) ? 0 : Math.min(needed - onPo, input.fromStock.get(item) || 0);
    const state: PartCoverState = onPo + fromStock < needed ? 'missing'
      : fromStock === 0 ? 'po'
        : onPo === 0 ? 'stock'
          : 'mixed';
    parts.push({ item_number: item, description: input.descriptions?.get(item) ?? null, needed, onPo, fromStock, state });
  }
  if (parts.length === 0) return null;
  parts.sort((a, b) => Number(b.state === 'missing') - Number(a.state === 'missing') || a.item_number.localeCompare(b.item_number));

  const ready = parts.filter(p => p.state !== 'missing').length;
  let marked: SoPartsCover['marked'] = null;
  const m = input.mark;
  if (m?.at) {
    const known = new Set((m.items || []).map(s => String(s).toUpperCase()));
    if (parts.every(p => known.has(p.item_number))) marked = { at: m.at, byName: m.byName };
  }
  return { total: parts.length, ready, allReady: ready === parts.length || !!marked, marked, parts };
}

/** "5 of 7 ready" / "Parts ordered". */
export function coverLabel(c: SoPartsCover): string {
  if (c.allReady) return 'Parts ordered';
  return `${c.ready} of ${c.total} ready`;
}

export function partCoverText(p: PartCover): string {
  if (p.state === 'po') return 'On a PO';
  if (p.state === 'stock') return 'In stock';
  if (p.state === 'mixed') return `${p.onPo} on a PO, ${p.fromStock} in stock`;
  const have = p.onPo + p.fromStock;
  return have > 0 ? `${have} of ${p.needed} covered` : 'Not ordered';
}
