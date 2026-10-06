import { normalizeItemNumber } from './incoming-parts';

/**
 * Upfit vs Graphics revenue (owner rule 2026-10-06).
 *
 * Every NetSuite invoice / credit-memo line is filed by its ITEM:
 *  - Graphics: 3M Vinyl, Graphics Install Labor, Graphics Removal, and any
 *    item number starting "06" (Masterack graphics — the Verizon RFID part
 *    starts "06" too, and the owner chose to keep it graphics).
 *  - Upfit: everything else, Parts Install Labor included.
 *  - Left out: tax (not selected), freight and shipping (owner: leave out),
 *    and layout lines (subtotal / group end / description) that carry no
 *    sale of their own.
 *  - Unsplit: discounts and lines with no item. They are real money but
 *    belong to no side, so they're shown on their own rather than guessed.
 *
 * Labor cost per side comes from Paychex payroll by payroll role
 * (migration 341, src/lib/paychex-payroll.ts); Shared (Sales + Office)
 * stays its own line.
 */

export type RevenueBucket = 'upfit' | 'graphics' | 'unsplit' | 'excluded';

export const GRAPHICS_ITEMS = new Set(['3M VINYL', 'GRAPHICS INSTALL LABOR', 'GRAPHICS REMOVAL']);
export const GRAPHICS_ITEM_PREFIX = '06';

/** NetSuite item types that are layout, not a sale. */
const LAYOUT_TYPES = new Set(['Subtotal', 'EndGroup', 'Group', 'Description']);
const isFreight = (num: string, type: string) => type === 'ShipItem' || /FREIGHT|SHIPPING/.test(num);

export function revenueBucket(itemNumber: string | null | undefined, itemType: string | null | undefined): RevenueBucket {
  const type = String(itemType || '');
  const num = normalizeItemNumber(itemNumber);
  if (LAYOUT_TYPES.has(type)) return 'excluded';
  if (!num) return 'unsplit';
  if (isFreight(num, type)) return 'excluded';
  if (type === 'Discount') return 'unsplit';
  if (GRAPHICS_ITEMS.has(num) || num.startsWith(GRAPHICS_ITEM_PREFIX)) return 'graphics';
  return 'upfit';
}

/**
 * Revenue by month and item over [from, to]: CustInvc minus CustCred,
 * non-tax lines, the same `-tl.netamount` sign convention as
 * src/lib/revenue-summary.ts so totals agree with the CEO view.
 */
export function buildRevenueByItemQuery(from: string, to: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) throw new Error('Bad date');
  return `
    SELECT TO_CHAR(t.trandate, 'YYYY-MM') AS month, i.itemid AS item_number, i.itemtype AS item_type,
           SUM(-tl.netamount) AS amount
    FROM transaction t
    INNER JOIN transactionline tl ON tl.transaction = t.id
    LEFT JOIN item i ON tl.item = i.id
    WHERE t.type IN ('CustInvc', 'CustCred')
      AND tl.mainline = 'F' AND tl.taxline = 'F'
      AND t.trandate >= TO_DATE('${from}', 'YYYY-MM-DD')
      AND t.trandate <= TO_DATE('${to}', 'YYYY-MM-DD')
    GROUP BY TO_CHAR(t.trandate, 'YYYY-MM'), i.itemid, i.itemtype
    ORDER BY TO_CHAR(t.trandate, 'YYYY-MM')`;
}

export interface RevenueItemRow { month: string; item_number: string | null; item_type: string | null; amount: number | string | null }
export interface LaborMonthRow { month: string; upfit: number; graphics: number; shared: number; unassigned: number }

export interface DivisionMonth {
  month: string;
  upfitRevenue: number;
  graphicsRevenue: number;
  unsplitRevenue: number;
  excludedRevenue: number;
  upfitLabor: number;
  graphicsLabor: number;
  sharedLabor: number;
  unassignedLabor: number;
  /** Revenue minus that side's own labor (shared not allocated). */
  upfitAfterLabor: number;
  graphicsAfterLabor: number;
}

export interface DivisionItem { item_number: string; item_type: string | null; bucket: RevenueBucket; amount: number }

export interface DivisionReport {
  months: DivisionMonth[];
  totals: Omit<DivisionMonth, 'month'>;
  items: DivisionItem[];
  /** Months with revenue but no uploaded payroll — their labor is missing, not zero. */
  monthsWithoutPayroll: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => parseFloat(String(v ?? 0)) || 0;

export function buildDivisionReport(revenue: RevenueItemRow[], labor: LaborMonthRow[]): DivisionReport {
  const empty = (month: string): DivisionMonth => ({
    month, upfitRevenue: 0, graphicsRevenue: 0, unsplitRevenue: 0, excludedRevenue: 0,
    upfitLabor: 0, graphicsLabor: 0, sharedLabor: 0, unassignedLabor: 0, upfitAfterLabor: 0, graphicsAfterLabor: 0,
  });
  const months = new Map<string, DivisionMonth>();
  const get = (m: string) => { let r = months.get(m); if (!r) { r = empty(m); months.set(m, r); } return r; };
  const items = new Map<string, DivisionItem>();
  const revenueMonths = new Set<string>();

  for (const r of revenue) {
    const amount = num(r.amount);
    if (!amount) continue;
    const bucket = revenueBucket(r.item_number, r.item_type);
    const m = get(String(r.month));
    m[`${bucket}Revenue` as const] += amount;
    if (bucket !== 'excluded') revenueMonths.add(m.month);
    const label = r.item_number ? normalizeItemNumber(r.item_number) : '(no item)';
    const key = `${label}|${r.item_type || ''}`;
    const it = items.get(key) || { item_number: label, item_type: r.item_type || null, bucket, amount: 0 };
    it.amount += amount;
    items.set(key, it);
  }
  const laborMonths = new Set<string>();
  for (const l of labor) {
    const m = get(l.month);
    m.upfitLabor += l.upfit;
    m.graphicsLabor += l.graphics;
    m.sharedLabor += l.shared;
    m.unassignedLabor += l.unassigned;
    laborMonths.add(l.month);
  }

  const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map(m => {
    const out: DivisionMonth = {
      month: m.month,
      upfitRevenue: round2(m.upfitRevenue),
      graphicsRevenue: round2(m.graphicsRevenue),
      unsplitRevenue: round2(m.unsplitRevenue),
      excludedRevenue: round2(m.excludedRevenue),
      upfitLabor: round2(m.upfitLabor),
      graphicsLabor: round2(m.graphicsLabor),
      sharedLabor: round2(m.sharedLabor),
      unassignedLabor: round2(m.unassignedLabor),
      upfitAfterLabor: 0,
      graphicsAfterLabor: 0,
    };
    out.upfitAfterLabor = round2(out.upfitRevenue - out.upfitLabor);
    out.graphicsAfterLabor = round2(out.graphicsRevenue - out.graphicsLabor);
    return out;
  });
  const totals: DivisionReport['totals'] = {
    upfitRevenue: 0, graphicsRevenue: 0, unsplitRevenue: 0, excludedRevenue: 0,
    upfitLabor: 0, graphicsLabor: 0, sharedLabor: 0, unassignedLabor: 0, upfitAfterLabor: 0, graphicsAfterLabor: 0,
  };
  const keys = Object.keys(totals) as (keyof DivisionReport['totals'])[];
  for (const r of rows) for (const k of keys) totals[k] += r[k];
  for (const k of keys) totals[k] = round2(totals[k]);

  return {
    months: rows,
    totals,
    items: [...items.values()].map(i => ({ ...i, amount: round2(i.amount) })).filter(i => i.amount).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)),
    monthsWithoutPayroll: [...revenueMonths].filter(m => !laborMonths.has(m)).sort(),
  };
}
