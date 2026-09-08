import { normalizeFilmName } from './material-costing';

/**
 * Roll stock (R6-2): how much film, premask and ink is actually in the
 * building, and what the roll plan should say before someone prints.
 *
 * All pure — the routes and the Roll Plan card feed it rows and act on
 * what it returns. Two rules worth stating up front:
 *
 *  - Consumption is drawn from the OLDEST open roll first. Vinyl ages,
 *    and a part-used roll is the one to finish, so FIFO is both the
 *    accounting convention and the right shop instinct.
 *  - A shortage is reported against total remaining across open rolls,
 *    but the plan ALSO reports whether any single roll can cover the run.
 *    Forty feet spread over four ten-foot remnants does not print a
 *    thirty-eight-foot job, and a total-only check would say it does.
 */

export type StockKind = 'film' | 'premask' | 'ink';
export type StockUnit = 'ft' | 'cartridge';

export interface StockRoll {
  id: string;
  substrateId: string | null;
  materialName: string;
  kind: StockKind;
  unit: StockUnit;
  widthIn: number | null;
  remainingQty: number;
  receivedAt: string;
  status: string;
}

export interface StockSummary {
  key: string;
  materialName: string;
  kind: StockKind;
  unit: StockUnit;
  substrateId: string | null;
  openRolls: number;
  totalRemaining: number;
  /** The most any ONE roll can cover — what a single continuous run needs. */
  longestRoll: number;
}

export const materialKey = (name: string) => normalizeFilmName(name);

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Linear feet of a roll consumed to cover `sqft` at a given roll width. */
export function linearFeetForSqft(sqft: number, widthIn: number | null | undefined): number | null {
  if (!widthIn || widthIn <= 0) return null;
  return round1((sqft * 144) / widthIn / 12);
}

/** Fold open rolls into one row per material. */
export function summarizeStock(rolls: StockRoll[]): StockSummary[] {
  const by = new Map<string, StockSummary>();
  for (const r of rolls) {
    if (r.status !== 'open' || r.remainingQty <= 0) continue;
    const key = `${r.kind}:${materialKey(r.materialName)}`;
    const row = by.get(key) || {
      key, materialName: r.materialName, kind: r.kind, unit: r.unit,
      substrateId: r.substrateId, openRolls: 0, totalRemaining: 0, longestRoll: 0,
    };
    row.openRolls += 1;
    row.totalRemaining = round1(row.totalRemaining + r.remainingQty);
    row.longestRoll = Math.max(row.longestRoll, r.remainingQty);
    if (!row.substrateId && r.substrateId) row.substrateId = r.substrateId;
    by.set(key, row);
  }
  return [...by.values()].sort((a, b) => a.materialName.localeCompare(b.materialName));
}

export interface Allocation { rollId: string; take: number }
export interface AllocationPlan {
  allocations: Allocation[];
  shortfall: number;
  /** True when no single open roll covers the whole run. */
  splitAcrossRolls: boolean;
}

/**
 * FIFO draw for `needed` units. Returns what to take from which roll, plus
 * any shortfall — the caller decides whether to warn or refuse.
 */
export function planDraw(rolls: StockRoll[], needed: number): AllocationPlan {
  const open = rolls
    .filter(r => r.status === 'open' && r.remainingQty > 0)
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
  const allocations: Allocation[] = [];
  let left = round1(needed);
  for (const r of open) {
    if (left <= 0) break;
    const take = Math.min(r.remainingQty, left);
    allocations.push({ rollId: r.id, take: round1(take) });
    left = round1(left - take);
  }
  const fitsOneRoll = open.some(r => r.remainingQty >= needed);
  return {
    allocations,
    shortfall: left > 0 ? round1(left) : 0,
    splitAcrossRolls: allocations.length > 1 && !fitsOneRoll,
  };
}

export interface StockPolicy {
  key: string;
  kind: StockKind;
  materialName: string;
  unit: StockUnit;
  reorderAt: number | null;
  orderUpTo: number | null;
  vendorName: string | null;
  itemNumber: string | null;
}

export interface LowStockHit {
  key: string;
  kind: StockKind;
  materialName: string;
  unit: StockUnit;
  onHand: number;
  reorderAt: number;
  suggestedQty: number;
  vendorName: string | null;
  itemNumber: string | null;
}

/**
 * Materials at or below their reorder point. A policy with no reorder_at
 * is WATCHED, not ordered — the same "configured means opted in" rule the
 * parts reorder sweep uses, so turning stock tracking on never silently
 * starts raising purchase requests.
 */
export function findLowStock(summaries: StockSummary[], policies: StockPolicy[]): LowStockHit[] {
  const onHand = new Map(summaries.map(s => [s.key, s.totalRemaining]));
  const hits: LowStockHit[] = [];
  for (const p of policies) {
    if (p.reorderAt == null) continue;
    const have = onHand.get(p.key) ?? 0;
    if (have > p.reorderAt) continue;
    const target = p.orderUpTo != null && p.orderUpTo > p.reorderAt ? p.orderUpTo : p.reorderAt;
    const suggested = round1(Math.max(target - have, 0));
    if (suggested <= 0) continue;
    hits.push({
      key: p.key, kind: p.kind, materialName: p.materialName, unit: p.unit,
      onHand: round1(have), reorderAt: p.reorderAt, suggestedQty: suggested,
      vendorName: p.vendorName, itemNumber: p.itemNumber,
    });
  }
  return hits.sort((a, b) => (a.onHand / (a.reorderAt || 1)) - (b.onHand / (b.reorderAt || 1)));
}

/** The Roll Plan card's one-line verdict. */
export function stockVerdict(
  neededFt: number | null,
  summary: StockSummary | undefined,
): { tone: 'ok' | 'warn' | 'short' | 'unknown'; text: string } {
  if (neededFt == null) {
    return { tone: 'unknown', text: 'Set a roll width on this film to check stock.' };
  }
  if (!summary) {
    return { tone: 'unknown', text: `Needs ${neededFt} lin ft — no stock on file for this film.` };
  }
  const have = summary.totalRemaining;
  if (have < neededFt) {
    return { tone: 'short', text: `Needs ${neededFt} lin ft — only ${have} ft left. Short ${round1(neededFt - have)} ft.` };
  }
  if (summary.longestRoll < neededFt) {
    return {
      tone: 'warn',
      text: `Needs ${neededFt} lin ft — ${have} ft on hand, but the longest single roll is ${round1(summary.longestRoll)} ft, so this run splits across rolls.`,
    };
  }
  return { tone: 'ok', text: `Needs ${neededFt} lin ft — ${have} ft on hand across ${summary.openRolls} roll${summary.openRolls !== 1 ? 's' : ''}.` };
}
