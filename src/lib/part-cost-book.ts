/**
 * Part cost book & price drift (R6-7). Every buy of every part already
 * sits in the PO mirror — item, quantity, rate, vendor, date — and nothing
 * ever read it back as a price history. So the catalog's purchase_price
 * quietly ages while real costs move, and margin math built on it drifts
 * with no alarm.
 *
 * Pure. The route feeds it mirror rows; the sweep feeds it the same rows
 * plus the catalog price.
 */

export interface Buy {
  itemNumber: string;
  poTranid: string | null;
  vendorName: string | null;
  trandate: string | null;
  quantity: number;
  rate: number;
}

export interface CostHistory {
  itemNumber: string;
  buys: Buy[];
  firstRate: number | null;
  lastRate: number | null;
  lastBuyDate: string | null;
  lastVendor: string | null;
  minRate: number | null;
  maxRate: number | null;
  /** Quantity-weighted average — what the part really averaged, not the
   *  mean of the rates, which lets a one-unit buy outweigh a pallet. */
  weightedAvgRate: number | null;
  buyCount: number;
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Order buys oldest → newest; rows with no usable rate are dropped. */
export function buildCostHistory(itemNumber: string, buys: Buy[]): CostHistory {
  const usable = buys
    .filter(b => Number.isFinite(b.rate) && b.rate > 0 && b.quantity > 0)
    .sort((a, b) => String(a.trandate || '').localeCompare(String(b.trandate || '')));

  if (usable.length === 0) {
    return {
      itemNumber, buys: [], firstRate: null, lastRate: null, lastBuyDate: null,
      lastVendor: null, minRate: null, maxRate: null, weightedAvgRate: null, buyCount: 0,
    };
  }

  const last = usable[usable.length - 1];
  const totalQty = usable.reduce((s, b) => s + b.quantity, 0);
  const totalCost = usable.reduce((s, b) => s + b.quantity * b.rate, 0);

  return {
    itemNumber,
    buys: usable,
    firstRate: round4(usable[0].rate),
    lastRate: round4(last.rate),
    lastBuyDate: last.trandate,
    lastVendor: last.vendorName,
    minRate: round4(Math.min(...usable.map(b => b.rate))),
    maxRate: round4(Math.max(...usable.map(b => b.rate))),
    weightedAvgRate: totalQty > 0 ? round4(totalCost / totalQty) : null,
    buyCount: usable.length,
  };
}

export type DriftSeverity = 'none' | 'minor' | 'material';

export interface PriceDrift {
  itemNumber: string;
  catalogPrice: number | null;
  lastRate: number | null;
  lastBuyDate: string | null;
  lastVendor: string | null;
  /** Signed: positive means the catalog is UNDER what we now pay. */
  driftPct: number | null;
  severity: DriftSeverity;
  buyCount: number;
}

/**
 * Compare the catalog's purchase_price to what the part actually last
 * cost. A catalog price of zero or null is "never set" — reported as
 * unknown rather than as infinite drift, which is the difference between
 * a worklist somebody works and one they ignore.
 */
export function computeDrift(
  history: CostHistory,
  catalogPrice: number | null | undefined,
  opts: { minorPct?: number; materialPct?: number; minBuys?: number } = {},
): PriceDrift {
  const minorPct = opts.minorPct ?? 5;
  const materialPct = opts.materialPct ?? 15;
  const minBuys = opts.minBuys ?? 1;

  const catalog = catalogPrice != null && catalogPrice > 0 ? Number(catalogPrice) : null;
  const base: PriceDrift = {
    itemNumber: history.itemNumber,
    catalogPrice: catalog,
    lastRate: history.lastRate,
    lastBuyDate: history.lastBuyDate,
    lastVendor: history.lastVendor,
    driftPct: null,
    severity: 'none',
    buyCount: history.buyCount,
  };
  if (catalog == null || history.lastRate == null || history.buyCount < minBuys) return base;

  const driftPct = round2(((history.lastRate - catalog) / catalog) * 100);
  const magnitude = Math.abs(driftPct);
  return {
    ...base,
    driftPct,
    severity: magnitude >= materialPct ? 'material' : magnitude >= minorPct ? 'minor' : 'none',
  };
}

/** The stale-cost worklist: material drift first, biggest first. */
export function staleCostWorklist(drifts: PriceDrift[]): PriceDrift[] {
  return drifts
    .filter(d => d.severity !== 'none')
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'material' ? -1 : 1;
      return Math.abs(b.driftPct || 0) - Math.abs(a.driftPct || 0);
    });
}
